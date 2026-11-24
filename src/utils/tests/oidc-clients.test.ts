import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { getMigrations } from 'better-auth/db/migration'
import { Pool } from 'pg'
import { createAccountAuth } from '../../lib/account-auth'
import { createOidcAppClient } from '../../lib/oidc-app-client'
import {
    loadConfiguredOidcClients,
    type OidcClientConfig,
    oidcClientsProblem,
    oidcSecretVariable,
    parseOidcClients,
    syncOidcClients
} from '../../lib/oidc-clients'
import { withRenamedSettings } from '../../lib/renamed-settings'

const LOGIN_ORIGIN = 'http://account.localhost:4000'
const WEB_ORIGIN = 'http://localhost:3001'
const SECRET = 'test-only-secret-with-at-least-thirty-two-characters'
const CLIENT_SECRET = 'client-secret-with-at-least-thirty-two-chars'
const ENV = {
    HAWCONNECT_AUTH_ORIGIN: 'http://localhost:4000',
    HAWCONNECT_WEB_ORIGIN: WEB_ORIGIN,
    HAWCONNECT_OIDC_SECRET_HAWCONNECT_APP: CLIENT_SECRET
}
const shipped = JSON.parse(
    readFileSync(
        new URL('../../../config/oidc-clients.json', import.meta.url),
        'utf8'
    )
)
const client = (patch: Record<string, unknown> = {}) => ({
    clientId: 'hawconnect-app',
    name: 'HAWConnect',
    type: 'confidential',
    firstParty: true,
    scopes: ['openid', 'email'],
    redirectUris: ['https://app.example.org/callback'],
    postLogoutRedirectUris: [],
    ...patch
})
const reason = (
    json: unknown,
    env: Record<string, string | undefined> = ENV
) => {
    try {
        parseOidcClients(json, env)
    } catch (error) {
        return (error as Error).message
    }
    return 'accepted'
}

describe('parseOidcClients', () => {
    it('accepts the shipped file and expands placeholders', () => {
        const [app] = parseOidcClients(shipped, ENV)
        expect(app).toMatchObject({
            clientId: 'hawconnect-app',
            name: 'HAWConnect App',
            type: 'confidential',
            firstParty: true,
            scopes: ['openid', 'email', 'offline_access'],
            redirectUris: [
                'http://localhost:4000/api/accounts/oidc/callback',
                'hawconnect://auth/callback'
            ],
            postLogoutRedirectUris: [`${WEB_ORIGIN}/`]
        })
    })

    it('leaves the dashboard client out where the dashboard is not configured', () => {
        const clients = parseOidcClients(shipped, ENV)
        expect(clients.map((c) => c.clientId)).toEqual(['hawconnect-app'])
    })

    it('registers the dashboard client once its origin and secret are set', () => {
        const clients = parseOidcClients(shipped, {
            ...ENV,
            HAWCONNECT_CONSOLE_ORIGIN: 'http://localhost:43127/',
            HAWCONNECT_OIDC_SECRET_HAWCONNECT_CONSOLE: CLIENT_SECRET
        })
        expect(
            clients.find((c) => c.clientId === 'hawconnect-console')
        ).toEqual({
            clientId: 'hawconnect-console',
            name: 'HAWConnect Console',
            type: 'confidential',
            firstParty: true,
            scopes: ['openid', 'email'],
            redirectUris: ['http://localhost:43127/auth/callback'],
            postLogoutRedirectUris: ['http://localhost:43127/login']
        })
    })

    it('leaves the dashboard client out until its secret is set, so the app keeps signing in', () => {
        const clients = parseOidcClients(shipped, {
            ...ENV,
            HAWCONNECT_CONSOLE_ORIGIN: 'http://localhost:43127'
        })
        expect(clients.map((c) => c.clientId)).toEqual(['hawconnect-app'])
    })

    it('refuses a `requires` that is not a known placeholder', () => {
        expect(() =>
            parseOidcClients([client({ requires: 'HOME' })], ENV)
        ).toThrow('InvalidOidcClients:shape:hawconnect-app')
    })

    it('refuses unknown or unset placeholders', () => {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal placeholder
        const unknown = client({ redirectUris: ['${HOME}/cb'] })
        expect(reason([unknown])).toBe('InvalidOidcClients:placeholder:HOME')
        expect(
            reason(shipped, { ...ENV, HAWCONNECT_WEB_ORIGIN: undefined })
        ).toBe('InvalidOidcClients:placeholder:HAWCONNECT_WEB_ORIGIN')
    })

    it('refuses unsafe redirect URIs', () => {
        for (const uri of [
            'https://app.example.org/*',
            'https://*.example.org/cb',
            'http://app.example.org/cb',
            'http://localhost.evil.org/cb',
            'https://app.example.org/cb#frag',
            'https://app.example.org/cb#',
            'https://user@app.example.org/cb',
            'https://user:pw@app.example.org/cb',
            'hawconnect://auth/other',
            'hawconnect://auth/callback?x=1',
            'otherscheme://auth/callback',
            'javascript:alert(1)',
            'not a url'
        ])
            expect(reason([client({ redirectUris: [uri] })])).toBe(
                'InvalidOidcClients:redirect:hawconnect-app'
            )
        expect(
            reason([client({ postLogoutRedirectUris: ['http://evil.org/'] })])
        ).toBe('InvalidOidcClients:redirect:hawconnect-app')
    })

    it('accepts https, localhost and the app scheme', () => {
        for (const uri of [
            'https://app.example.org/cb',
            'http://localhost:8081/cb',
            'http://web.localhost:3000/cb',
            'hawconnect://auth/callback'
        ])
            expect(reason([client({ redirectUris: [uri] })])).toBe('accepted')
    })

    it('refuses duplicates, scopes and missing or short secrets', () => {
        expect(reason([client(), client()])).toBe(
            'InvalidOidcClients:duplicate:hawconnect-app'
        )
        expect(reason([client({ scopes: ['openid', 'profile'] })])).toBe(
            'InvalidOidcClients:scope:hawconnect-app'
        )
        expect(
            reason([client()], {
                ...ENV,
                HAWCONNECT_OIDC_SECRET_HAWCONNECT_APP: undefined
            })
        ).toBe('InvalidOidcClients:secret:hawconnect-app')
        expect(
            reason([client()], {
                ...ENV,
                HAWCONNECT_OIDC_SECRET_HAWCONNECT_APP: 'a'.repeat(31)
            })
        ).toBe('InvalidOidcClients:secret:hawconnect-app')
        expect(
            reason([client()], {
                ...ENV,
                HAWCONNECT_OIDC_SECRET_HAWCONNECT_APP: 'a'.repeat(32)
            })
        ).toBe('accepted')
    })

    it('needs no secret for a public client', () => {
        expect(reason([client({ type: 'public' })], {})).toBe('accepted')
    })

    it('expands origins exactly as the app client sends them, trailing slash or not', () => {
        const env = {
            ...ENV,
            HAWCONNECT_AUTH_ORIGIN: 'http://localhost:4000/',
            HAWCONNECT_WEB_ORIGIN: `${WEB_ORIGIN}/`
        }
        const [app] = parseOidcClients(shipped, env)
        const oidc = createOidcAppClient({
            auth: {} as never,
            secret: SECRET,
            apiOrigin: env.HAWCONNECT_AUTH_ORIGIN,
            loginOrigin: `${LOGIN_ORIGIN}/`,
            webOrigin: env.HAWCONNECT_WEB_ORIGIN,
            clientSecret: CLIENT_SECRET
        })
        const authorize = new URL(
            oidc
                .start(
                    new Request('http://localhost:4000/api/accounts/oidc/start')
                )
                .headers.get('location') ?? ''
        )
        expect(app.redirectUris).toContain(
            authorize.searchParams.get('redirect_uri') as string
        )
        expect(app.redirectUris[0]).toBe(
            'http://localhost:4000/api/accounts/oidc/callback'
        )
        const end = new URL(oidc.endSessionUrl('user-1'))
        expect(app.postLogoutRedirectUris).toEqual([
            end.searchParams.get('post_logout_redirect_uri') as string
        ])
        expect(app.postLogoutRedirectUris).toEqual([`${WEB_ORIGIN}/`])
    })

    it('refuses an origin placeholder that is not a URL', () => {
        expect(
            reason(shipped, { ...ENV, HAWCONNECT_WEB_ORIGIN: 'localhost:3001' })
        ).toBe('InvalidOidcClients:placeholder:HAWCONNECT_WEB_ORIGIN')
    })

    it('trims the client secret before the length check', () => {
        expect(
            reason([client()], {
                ...ENV,
                HAWCONNECT_OIDC_SECRET_HAWCONNECT_APP: `  ${'a'.repeat(31)}\n`
            })
        ).toBe('InvalidOidcClients:secret:hawconnect-app')
        expect(
            reason([client()], {
                ...ENV,
                HAWCONNECT_OIDC_SECRET_HAWCONNECT_APP: `${'a'.repeat(32)}\n`
            })
        ).toBe('accepted')
    })
})

describe('oidcClientsProblem', () => {
    it('names the cause, never a value', () => {
        expect(
            oidcClientsProblem(
                new Error('InvalidOidcClients:secret:hawconnect-app')
            )
        ).toBe(
            'HAWCONNECT_OIDC_SECRET_HAWCONNECT_APP missing or shorter than 32 characters'
        )
        expect(
            oidcClientsProblem(
                new Error(
                    'InvalidOidcClients:placeholder:HAWCONNECT_WEB_ORIGIN'
                )
            )
        ).toBe('HAWCONNECT_WEB_ORIGIN missing or not a URL')
        expect(
            oidcClientsProblem(
                new Error('InvalidOidcClients:redirect:hawconnect-app')
            )
        ).toBe('config/oidc-clients.json: invalid redirect (hawconnect-app)')
        expect(oidcClientsProblem(new SyntaxError('Unexpected token x'))).toBe(
            'config/oidc-clients.json is not valid JSON'
        )
        expect(
            oidcClientsProblem(
                Object.assign(new Error('ENOENT: /secret/path'), {
                    code: 'ENOENT'
                })
            )
        ).toBe('config/oidc-clients.json missing')
        // Anything else (e.g. the database) is named without its message.
        expect(
            oidcClientsProblem(
                new Error('password authentication failed for "x"')
            )
        ).toBe('database not ready or unreachable')
    })
})

const databaseURL = process.env.HAWCONNECT_TEST_DATABASE_URL
const suite = databaseURL ? describe : describe.skip
suite('syncOidcClients (isolated PostgreSQL)', () => {
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
    const run = `sync${crypto.randomUUID().slice(0, 8)}`
    const idA = `${run}-a`
    const idB = `${run}-b`
    const base64url = (buffer: Buffer) =>
        buffer
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '')
    const rows = async () =>
        (
            await pool.query(
                'SELECT * FROM haw_oauth_client WHERE "clientId" LIKE $1 ORDER BY "clientId"',
                [`${run}-%`]
            )
        ).rows
    const config = (patch: Partial<OidcClientConfig> = {}) =>
        parseOidcClients(
            [
                client({ clientId: idA, name: 'A' }),
                client({
                    clientId: idB,
                    name: 'B',
                    type: 'public',
                    firstParty: false
                })
            ].map((entry) => ({ ...entry, ...patch })),
            { ...ENV, [oidcSecretVariable(idA)]: CLIENT_SECRET }
        )
    const sync = (clients: OidcClientConfig[]) =>
        syncOidcClients(service.auth, clients, {
            [oidcSecretVariable(idA)]: CLIENT_SECRET
        })
    const authorize = async (clientId: string) => {
        const verifier = base64url(Buffer.from(crypto.randomUUID()))
        const discovery = (await (
            await service.auth.handler(
                new Request(`${LOGIN_ORIGIN}/.well-known/openid-configuration`)
            )
        ).json()) as { authorization_endpoint: string }
        const url = new URL(discovery.authorization_endpoint)
        url.search = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: 'https://app.example.org/callback',
            scope: 'openid',
            state: 's',
            code_challenge: base64url(
                createHash('sha256').update(verifier).digest()
            ),
            code_challenge_method: 'S256'
        }).toString()
        const response = await service.auth.handler(new Request(url))
        return new URL(response.headers.get('location') ?? 'http://none/')
    }

    beforeAll(async () => {
        await (await getMigrations(service.auth.options)).runMigrations()
    })
    afterAll(async () => {
        await pool.end()
    })

    it('is idempotent and stores owner-less, PKCE-bound clients', async () => {
        await sync(config())
        await sync(config())
        const stored = await rows()
        expect(stored.map((row) => row.clientId)).toEqual([idA, idB])
        const [a, b] = stored
        expect(a).toMatchObject({
            userId: null,
            referenceId: null,
            disabled: false,
            skipConsent: true,
            requirePKCE: true,
            name: 'A'
        })
        expect(b).toMatchObject({ skipConsent: false, requirePKCE: true })
        expect(a.clientSecret).not.toContain(CLIENT_SECRET)
        expect(b.clientSecret).toBeNull()
        expect(a.tokenEndpointAuthMethod).toBe('client_secret_post')
        expect(b.tokenEndpointAuthMethod).toBe('none')
    })

    it('updates redirect URIs from the file', async () => {
        const next = 'https://app.example.org/other'
        await sync(config({ redirectUris: [next] }))
        const [a] = await rows()
        expect(a.redirectUris).toEqual([next])
        expect((await rows()).length).toBe(2)
    })

    it('disables a removed client instead of deleting it', async () => {
        await sync(config())
        await sync(config().slice(0, 1))
        const stored = await rows()
        expect(stored.length).toBe(2)
        expect(stored.find((row) => row.clientId === idB).disabled).toBe(true)
        const location = await authorize(idB)
        expect(location.pathname).toBe('/error')
        expect(location.searchParams.get('error')).toBe('client_disabled')
        const token = await service.auth.handler(
            new Request(`${LOGIN_ORIGIN}/api/auth/oauth2/token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    code: 'x',
                    redirect_uri: 'https://app.example.org/callback',
                    code_verifier: 'v'.repeat(43),
                    client_id: idB
                })
            })
        )
        expect(token.status).toBe(400)
        expect(((await token.json()) as { error: string }).error).toBe(
            'invalid_client'
        )
        // A returning client is enabled again.
        await sync(config())
        expect(
            (await rows()).find((row) => row.clientId === idB).disabled
        ).toBe(false)
    })

    it('never leaves the secret in plain text or in errors', async () => {
        expect(JSON.stringify(await rows())).not.toContain(CLIENT_SECRET)
        await expect(
            syncOidcClients(service.auth, config(), {})
        ).rejects.toThrow(`InvalidOidcClients:secret:${idA}`)
    })
})

describe('renamed settings', () => {
    it('still registers the console client from the old HAWCONNECT_DASH_* names', async () => {
        const clients = await loadConfiguredOidcClients({
            HAWCONNECT_AUTH_ORIGIN: 'http://localhost:4000',
            HAWCONNECT_WEB_ORIGIN: 'http://localhost:8081',
            HAWCONNECT_OIDC_SECRET_HAWCONNECT_APP: CLIENT_SECRET,
            HAWCONNECT_DASH_ORIGIN: 'http://localhost:43127',
            HAWCONNECT_OIDC_SECRET_HAWCONNECT_DASH: CLIENT_SECRET
        })
        expect(
            clients.find((c) => c.clientId === 'hawconnect-console')
                ?.redirectUris
        ).toEqual(['http://localhost:43127/auth/callback'])
    })
    it('prefers the new name when both are set', () => {
        expect(
            withRenamedSettings({
                HAWCONNECT_CONSOLE_ORIGIN: 'https://new',
                HAWCONNECT_DASH_ORIGIN: 'https://old'
            }).HAWCONNECT_CONSOLE_ORIGIN
        ).toBe('https://new')
    })
})
