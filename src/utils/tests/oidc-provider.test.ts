import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { getMigrations } from 'better-auth/db/migration'
import { Pool } from 'pg'
import { createAccountAuth } from '../../lib/account-auth'
import { createAccountRuntime } from '../../lib/account-runtime'
import { oidcSecretVariable, syncOidcClients } from '../../lib/oidc-clients'

const LOGIN_ORIGIN = 'http://account.localhost:4000'
const WEB_ORIGIN = 'http://localhost:3001'
const SECRET = 'test-only-secret-with-at-least-thirty-two-characters'
const PASSWORD = 'correct horse 42 battery'
const CLIENT_SECRET = 'client-secret-with-at-least-thirty-two-chars'
const REDIRECT = 'https://app.example.org/oidc-test/callback'

describe('login origin configuration', () => {
    it('requires the login origin for public accounts', () => {
        expect(() =>
            createAccountAuth({
                pool: new Pool(),
                secret: SECRET,
                baseURL: 'http://localhost:4000',
                webOrigin: WEB_ORIGIN,
                registration: true
            })
        ).toThrow('LoginOriginRequired')
    })
})

describe('account runtime without a login origin', () => {
    it('disables only accounts instead of throwing', () => {
        const env = {
            HAWCONNECT_ACCOUNTS_DATABASE_URL:
                'postgres://localhost/hawconnect_scratch_unused',
            HAWCONNECT_ACCOUNT_SECRET: SECRET,
            HAWCONNECT_AUTH_ORIGIN: 'http://localhost:4000',
            HAWCONNECT_WEB_ORIGIN: WEB_ORIGIN
        }
        expect(() => createAccountRuntime(env)).not.toThrow()
        expect(createAccountRuntime(env)).toBeNull()
    })

    it('disables accounts when the login origin is the API origin', () => {
        const warn = console.warn
        const lines: string[] = []
        console.warn = (line: string) => lines.push(line)
        try {
            expect(
                createAccountRuntime({
                    HAWCONNECT_ACCOUNTS_DATABASE_URL:
                        'postgres://localhost/hawconnect_scratch_unused',
                    HAWCONNECT_ACCOUNT_SECRET: SECRET,
                    HAWCONNECT_AUTH_ORIGIN: 'http://localhost:4000',
                    HAWCONNECT_WEB_ORIGIN: WEB_ORIGIN,
                    HAWCONNECT_LOGIN_ORIGIN: 'http://localhost:4000/'
                })
            ).toBeNull()
        } finally {
            console.warn = warn
        }
        expect(lines).toEqual([
            'Accounts disabled: HAWCONNECT_LOGIN_ORIGIN must differ from HAWCONNECT_AUTH_ORIGIN'
        ])
    })
})

const databaseURL = process.env.HAWCONNECT_TEST_DATABASE_URL
const suite = databaseURL ? describe : describe.skip
suite('OpenID Connect provider core (isolated PostgreSQL)', () => {
    const pool = new Pool({ connectionString: databaseURL })
    const service = createAccountAuth({
        pool,
        secret: SECRET,
        baseURL: 'http://localhost:4000',
        loginOrigin: LOGIN_ORIGIN,
        webOrigin: WEB_ORIGIN,
        registration: true,
        send: async () => {}
    })
    const accounts = (
        target: ReturnType<typeof createAccountAuth>,
        path: string,
        options: {
            body?: unknown
            cookie?: string
            bearer?: string
            native?: boolean
        } = {}
    ) => {
        const native = options.native || options.bearer !== undefined
        return target.handler(
            new Request(`http://localhost:4000/api/accounts/${path}`, {
                method: options.body ? 'POST' : 'GET',
                headers: {
                    Origin: native ? 'hawconnect://' : WEB_ORIGIN,
                    'x-hawconnect-client-ip': crypto.randomUUID(),
                    ...(native ? { 'x-hawconnect-client': 'native' } : {}),
                    ...(options.bearer
                        ? { Authorization: `Bearer ${options.bearer}` }
                        : {}),
                    ...(options.body
                        ? { 'Content-Type': 'application/json' }
                        : {}),
                    ...(options.cookie ? { cookie: options.cookie } : {})
                },
                ...(options.body ? { body: JSON.stringify(options.body) } : {})
            })
        )
    }
    const cookiesOf = (response: Response) =>
        response.headers
            .getSetCookie()
            .map((s) => s.split(';')[0])
            .join('; ')
    const confirmedUser = async (email: string) => {
        await service.auth.api.signUpEmail({
            body: { email, password: PASSWORD, name: '' }
        })
        await pool.query(
            'UPDATE haw_user SET "emailVerified" = true WHERE email = $1',
            [email]
        )
    }
    const signIn = async (email: string) => {
        const response = await accounts(service, 'sign-in', {
            body: { email, password: PASSWORD }
        })
        expect(response.status).toBe(200)
        return cookiesOf(response)
    }
    const base64url = (buffer: Buffer) =>
        buffer
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '')
    /** Registers a first-party test client the way the server does: from configuration. */
    const registerClient = async () => {
        const clientId = `test-${crypto.randomUUID()}`
        await syncOidcClients(
            service.auth,
            [
                {
                    clientId,
                    name: 'Test client',
                    type: 'confidential',
                    firstParty: true,
                    scopes: ['openid', 'email', 'offline_access'],
                    redirectUris: [REDIRECT],
                    postLogoutRedirectUris: []
                }
            ],
            { [oidcSecretVariable(clientId)]: CLIENT_SECRET }
        )
        return { client_id: clientId, client_secret: CLIENT_SECRET }
    }
    let discovery: Record<string, unknown>
    let discoveryURL: string

    beforeAll(async () => {
        const migration = await getMigrations(service.auth.options)
        await migration.runMigrations()
        discoveryURL = `${LOGIN_ORIGIN}/.well-known/openid-configuration`
        const response = await service.auth.handler(new Request(discoveryURL))
        expect(response.status).toBe(200)
        discovery = (await response.json()) as Record<string, unknown>
    })
    afterAll(async () => {
        await pool.end()
    })

    it('publishes discovery with the login origin as issuer', () => {
        expect(discovery.issuer).toBe(LOGIN_ORIGIN)
        expect(
            discoveryURL.replace(/\/\.well-known\/openid-configuration$/, '')
        ).toBe(discovery.issuer as string)
        expect(String(discovery.issuer).startsWith(LOGIN_ORIGIN)).toBe(true)
        expect(discovery.code_challenge_methods_supported).toEqual(['S256'])
        expect(discovery.response_types_supported).toEqual(['code'])
        const grants = discovery.grant_types_supported as string[]
        expect(grants).not.toContain('password')
        expect(grants).not.toContain('implicit')
        expect(grants).not.toContain('client_credentials')
        expect(discovery.scopes_supported).toEqual(
            expect.arrayContaining(['openid', 'email', 'offline_access'])
        )
        expect(discovery.scopes_supported).not.toContain('profile')
        expect(discovery.claims_supported).not.toContain('haw_verified')
        expect(discovery.registration_endpoint).toBeUndefined()
        for (const key of [
            'authorization_endpoint',
            'token_endpoint',
            'userinfo_endpoint',
            'jwks_uri',
            'end_session_endpoint'
        ])
            expect(String(discovery[key]).startsWith(LOGIN_ORIGIN)).toBe(true)
    })

    it('gives every account the same claims, with no HAW marker', async () => {
        const run = crypto.randomUUID()
        const client = await registerClient()
        const claimsFor = async (email: string) => {
            await confirmedUser(email)
            const cookie = await signIn(email)
            const verifier = base64url(Buffer.from(crypto.randomUUID() + run))
            const authorize = new URL(String(discovery.authorization_endpoint))
            authorize.search = new URLSearchParams({
                response_type: 'code',
                client_id: client.client_id,
                redirect_uri: REDIRECT,
                scope: 'openid email',
                state: crypto.randomUUID(),
                nonce: crypto.randomUUID(),
                code_challenge: base64url(
                    createHash('sha256').update(verifier).digest()
                ),
                code_challenge_method: 'S256'
            }).toString()
            const redirected = await service.auth.handler(
                new Request(authorize, { headers: { cookie } })
            )
            expect(redirected.status).toBe(302)
            const callback = new URL(redirected.headers.get('location') ?? '')
            expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT)
            const code = callback.searchParams.get('code') ?? ''
            expect(code.length).toBeGreaterThan(0)
            const token = await service.auth.handler(
                new Request(String(discovery.token_endpoint), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        code,
                        redirect_uri: REDIRECT,
                        code_verifier: verifier,
                        client_id: client.client_id,
                        client_secret: client.client_secret
                    })
                })
            )
            expect(token.status).toBe(200)
            const tokens = (await token.json()) as {
                access_token: string
                id_token: string
                expires_in: number
            }
            expect(tokens.expires_in).toBe(900)
            const info = await service.auth.handler(
                new Request(String(discovery.userinfo_endpoint), {
                    headers: { Authorization: `Bearer ${tokens.access_token}` }
                })
            )
            expect(info.status).toBe(200)
            const userinfo = (await info.json()) as Record<string, unknown>
            const idToken = JSON.parse(
                Buffer.from(
                    tokens.id_token.split('.')[1] ?? '',
                    'base64url'
                ).toString()
            ) as Record<string, unknown>
            expect(idToken.iss).toBe(LOGIN_ORIGIN)
            expect(Number(idToken.exp) - Number(idToken.iat)).toBe(900)
            expect(userinfo.email).toBe(email)
            expect('haw_verified' in idToken).toBe(false)
            expect('haw_verified' in userinfo).toBe(false)
            return Object.keys(userinfo).sort()
        }
        expect(await claimsFor(`a-${run}@haw-hamburg.de`)).toEqual(
            await claimsFor(`a-${run}@example.org`)
        )
    })

    it('refuses the plain PKCE method and requests without PKCE', async () => {
        const email = `oidc-plain-${crypto.randomUUID()}@mail.example.org`
        await confirmedUser(email)
        const cookie = await signIn(email)
        const client = await registerClient()
        for (const pkce of [
            { code_challenge: 'a'.repeat(43), code_challenge_method: 'plain' },
            {} as Record<string, string>
        ]) {
            const authorize = new URL(String(discovery.authorization_endpoint))
            authorize.search = new URLSearchParams({
                response_type: 'code',
                client_id: client.client_id,
                redirect_uri: REDIRECT,
                scope: 'openid email',
                state: 'state-value',
                ...pkce
            }).toString()
            const response = await service.auth.handler(
                new Request(authorize, { headers: { cookie } })
            )
            expect(response.status).toBe(302)
            const location = new URL(response.headers.get('location') ?? '')
            expect(location.searchParams.get('code')).toBeNull()
            expect(location.searchParams.get('error')).toBe('invalid_request')
        }
    })

    it('keeps existing app sessions valid', async () => {
        // The pre-provider service: the old base URL and no OpenID Connect add-ons.
        // A registration instance needs loginOrigin now, so seed through `password`
        // (bearer) and `confirm` (cookie). Like the browser `sign-in` route, both end in
        // better-auth's own session creation (sign-in/email, magic-link/verify), writing the
        // same haw_session row and the same signed hawconnect.session_token cookie.
        const links: string[] = []
        const before = createAccountAuth({
            pool,
            secret: SECRET,
            baseURL: 'http://localhost:4000',
            webOrigin: WEB_ORIGIN,
            passwordLogin: true,
            signInLink: true,
            send: async (message) => {
                links.push(message.url)
            }
        })
        const email = `oidc-existing-${crypto.randomUUID()}@mail.example.org`
        await confirmedUser(email)
        const native = await accounts(before, 'password', {
            body: { email, password: PASSWORD },
            native: true
        })
        expect(native.status).toBe(200)
        const { token } = (await native.json()) as { token: string }
        expect(token.length).toBeGreaterThan(0)
        expect(
            (await accounts(before, 'request-link', { body: { email } })).status
        ).toBe(200)
        const linkToken = new URLSearchParams(
            new URL(links.at(-1) ?? '').hash.slice(1)
        ).get('token')
        const browser = await accounts(before, 'confirm', {
            body: { token: linkToken }
        })
        expect(browser.status).toBe(200)
        const cookie = cookiesOf(browser)
        expect(cookie).toContain('hawconnect.session_token=')

        const byCookie = await accounts(service, 'session', { cookie })
        expect(byCookie.status).toBe(200)
        expect(
            ((await byCookie.json()) as { user: { email: string } }).user
        ).toMatchObject({ email })
        const byBearer = await accounts(service, 'session', { bearer: token })
        expect(byBearer.status).toBe(200)
        expect(
            ((await byBearer.json()) as { user: { email: string } }).user
        ).toMatchObject({ email })
    })

    it('refuses every user-initiated client change', async () => {
        const email = `oidc-refused-${crypto.randomUUID()}@mail.example.org`
        await confirmedUser(email)
        const cookie = await signIn(email)
        const post = (path: string, body: unknown) =>
            service.auth.handler(
                new Request(`${LOGIN_ORIGIN}/api/auth/oauth2/${path}`, {
                    method: 'POST',
                    headers: {
                        Origin: WEB_ORIGIN,
                        'Content-Type': 'application/json',
                        cookie
                    },
                    body: JSON.stringify(body)
                })
            )
        const before = (await pool.query('SELECT 1 FROM haw_oauth_client'))
            .rowCount
        const created = await post('create-client', {
            redirect_uris: [REDIRECT],
            scope: 'openid email',
            token_endpoint_auth_method: 'client_secret_post',
            skip_consent: true
        })
        expect(created.status).toBe(401)
        expect(
            (await pool.query('SELECT 1 FROM haw_oauth_client')).rowCount
        ).toBe(before)
        const own = await registerClient()
        for (const [path, body] of [
            ['update-client', { client_id: own.client_id, update: {} }],
            ['delete-client', { client_id: own.client_id }]
        ] as const)
            expect((await post(path, body)).status).toBe(401)
        for (const path of ['get-client?client_id=x', 'get-clients'])
            expect(
                (
                    await service.auth.handler(
                        new Request(`${LOGIN_ORIGIN}/api/auth/oauth2/${path}`, {
                            headers: { Origin: WEB_ORIGIN, cookie }
                        })
                    )
                ).status
            ).toBe(401)
        await expect(
            service.auth.api.adminCreateOAuthClient({
                headers: new Headers({ cookie }),
                body: { redirect_uris: [REDIRECT] }
            })
        ).rejects.toThrow()
        expect(
            (await pool.query('SELECT 1 FROM haw_oauth_client')).rowCount
        ).toBe(before + 1)
    })

    it('creates only prefixed tables', async () => {
        const tables = (
            await pool.query(
                'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()'
            )
        ).rows.map((row: { table_name: string }) => row.table_name)
        expect(
            tables.filter(
                (name) =>
                    name.toLowerCase().startsWith('oauth') ||
                    name.toLowerCase() === 'jwks'
            )
        ).toEqual([])
        expect(tables).toEqual(
            expect.arrayContaining(['haw_oauth_client', 'haw_jwks'])
        )
    })

    it('leaves the dashboard instance without the provider', async () => {
        const dashboard = createAccountAuth({
            pool,
            secret: SECRET,
            baseURL: 'http://localhost:4000',
            webOrigin: WEB_ORIGIN,
            passwordLogin: true,
            signInLink: true
        })
        const response = await dashboard.auth.handler(
            new Request(
                'http://localhost:4000/api/auth/.well-known/openid-configuration'
            )
        )
        expect(response.status).toBe(404)
    })
})
