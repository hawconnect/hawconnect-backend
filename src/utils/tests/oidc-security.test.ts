import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    setSystemTime
} from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getMigrations } from 'better-auth/db/migration'
import { toNodeHandler } from 'better-auth/node'
import express from 'express'
import { Pool } from 'pg'
import { type AccountMail, createAccountAuth } from '../../lib/account-auth'
import { createAppSession } from '../../lib/app-session'
import {
    loadConfiguredOidcClients,
    type OidcClientConfig,
    oidcSecretVariable,
    syncOidcClients
} from '../../lib/oidc-clients'
import { createLoginHost, loginHostGate } from '../../login/router'

/**
 * The provider's security promises (spec: "Security requirements", "The provider",
 * "Anti-goals"), each proven against the real provider in process.
 */
const API = 'http://localhost:4000'
const LOGIN = 'http://account.localhost:4000'
const LOGIN_HOST = 'account.localhost:4000'
const API_HOST = 'localhost:4000'
const WEB = 'http://localhost:8081'
const SECRET = 'test-only-secret-with-at-least-thirty-two-characters'
const APP_SECRET = 'app-client-secret-with-at-least-thirty-two-chars'
const PASSWORD = 'correct horse 42 battery'
const APP_CALLBACK = `${API}/api/accounts/oidc/callback`
/** A test-only confidential client that, unlike the app, asks for refresh tokens. */
const OFFLINE: OidcClientConfig = {
    clientId: 'b6-offline-test',
    name: 'Offline test client',
    type: 'confidential',
    firstParty: true,
    scopes: ['openid', 'email', 'offline_access'],
    redirectUris: [`${API}/b6-offline/callback`],
    postLogoutRedirectUris: []
}
const OFFLINE_SECRET = 'offline-test-client-secret-thirty-two-plus'
const OFFLINE_CALLBACK = OFFLINE.redirectUris[0] as string

const databaseURL = process.env.HAWCONNECT_TEST_DATABASE_URL
const suite = databaseURL ? describe : describe.skip
suite('OpenID Connect provider security (isolated PostgreSQL)', () => {
    const pool = new Pool({ connectionString: databaseURL })
    const env = {
        HAWCONNECT_AUTH_ORIGIN: API,
        HAWCONNECT_WEB_ORIGIN: WEB,
        [oidcSecretVariable('hawconnect-app')]: APP_SECRET,
        [oidcSecretVariable(OFFLINE.clientId)]: OFFLINE_SECRET
    }
    const sent: AccountMail[] = []
    const service = createAccountAuth({
        pool,
        secret: SECRET,
        baseURL: API,
        loginOrigin: LOGIN,
        webOrigin: WEB,
        registration: true,
        appClientSecret: APP_SECRET,
        send: async (message) => {
            sent.push(message)
        }
    })
    // Both hosts exactly as index.ts wires them: the login-host gate first, then the
    // API's bounded account wrapper. No raw /api/auth route exists on the API host.
    const app = express()
    let server: Server
    let base: string

    const pkce = () => {
        const verifier = randomBytes(32).toString('base64url')
        return {
            verifier,
            challenge: createHash('sha256').update(verifier).digest('base64url')
        }
    }
    const cookiePairs = (setCookie: string[]) =>
        setCookie
            .map((cookie) => cookie.split(';')[0])
            .filter((pair) => pair && !pair.endsWith('='))
            .join('; ')
    const authorizeURL = (params: Record<string, string | undefined>) => {
        const url = new URL(`${LOGIN}/api/auth/oauth2/authorize`)
        for (const [name, value] of Object.entries(params))
            if (value !== undefined) url.searchParams.set(name, value)
        return url.toString()
    }
    const flow = (
        client: 'app' | 'offline',
        extra: Record<string, string | undefined> = {}
    ) => {
        const { verifier, challenge } = pkce()
        const url = authorizeURL({
            response_type: 'code',
            client_id: client === 'app' ? 'hawconnect-app' : OFFLINE.clientId,
            redirect_uri: client === 'app' ? APP_CALLBACK : OFFLINE_CALLBACK,
            scope:
                client === 'app'
                    ? 'openid email'
                    : 'openid email offline_access',
            state: randomBytes(12).toString('base64url'),
            nonce: randomBytes(12).toString('base64url'),
            code_challenge: challenge,
            code_challenge_method: 'S256',
            ...extra
        })
        return { url, verifier }
    }
    const authorize = (url: string, cookie = '') =>
        service.auth.handler(
            new Request(url, {
                headers: { ...(cookie ? { cookie } : {}), Accept: 'text/html' }
            })
        )
    const locationOf = (response: Response) =>
        new URL(response.headers.get('location') ?? '', LOGIN)
    const confirmedUser = async () => {
        const email = `security-${crypto.randomUUID()}@mail.example.org`
        await service.auth.api.signUpEmail({
            body: { email, password: PASSWORD, name: '' }
        })
        const { rows } = await pool.query(
            'UPDATE haw_user SET "emailVerified" = true WHERE email = $1 RETURNING id',
            [email]
        )
        return { email, userId: rows[0].id as string }
    }
    /** What the login site does: authorize sends to /sign-in, the form signs in and continues. */
    const signInAtLogin = async (url: string, email: string) => {
        const first = await authorize(url)
        expect(first.status).toBe(302)
        const page = locationOf(first)
        expect(`${page.origin}${page.pathname}`).toBe(`${LOGIN}/sign-in`)
        const result = await service.actions.signIn(
            email,
            PASSWORD,
            new Headers({ origin: LOGIN }),
            page.search.slice(1)
        )
        if (!result.ok) throw new Error(result.code)
        return {
            loginCookie: cookiePairs(result.value.setCookie),
            redirect: new URL(result.value.redirect ?? '')
        }
    }
    const codeOf = (redirect: URL, callback: string) => {
        expect(`${redirect.origin}${redirect.pathname}`).toBe(callback)
        const code = redirect.searchParams.get('code')
        expect(code).toBeTruthy()
        return code as string
    }
    /** A new code for a person already signed in at the login site. */
    const nextCode = async (loginCookie: string) => {
        const { url, verifier } = flow('offline')
        const response = await authorize(url, loginCookie)
        expect(response.status).toBe(302)
        return {
            code: codeOf(locationOf(response), OFFLINE_CALLBACK),
            verifier
        }
    }
    const tokenEndpoint = async (params: Record<string, string>) => {
        const response = await service.auth.handler(
            new Request(`${LOGIN}/api/auth/oauth2/token`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    client_id: OFFLINE.clientId,
                    client_secret: OFFLINE_SECRET,
                    ...params
                }).toString()
            })
        )
        return {
            status: response.status,
            body: (await response.json()) as Record<string, unknown>
        }
    }
    const redeem = (code: string, verifier: string) =>
        tokenEndpoint({
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            redirect_uri: OFFLINE_CALLBACK
        })
    const refresh = (token: string) =>
        tokenEndpoint({ grant_type: 'refresh_token', refresh_token: token })
    const userinfo = (accessToken: string) =>
        service.auth.handler(
            new Request(`${LOGIN}/api/auth/oauth2/userinfo`, {
                headers: { Authorization: `Bearer ${accessToken}` }
            })
        )
    /** A person signed in at the login site who holds tokens of the offline client. */
    const personWithTokens = async () => {
        const person = await confirmedUser()
        const { url, verifier } = flow('offline')
        const { loginCookie, redirect } = await signInAtLogin(url, person.email)
        const tokens = await redeem(
            codeOf(redirect, OFFLINE_CALLBACK),
            verifier
        )
        expect(tokens.status).toBe(200)
        const accessToken = tokens.body.access_token as string
        const refreshToken = tokens.body.refresh_token as string
        expect(refreshToken).toBeTruthy()
        expect((await userinfo(accessToken)).status).toBe(200)
        return { ...person, loginCookie, accessToken, refreshToken }
    }
    const nativeAccounts = (path: string, bearer: string) =>
        service.handler(
            new Request(`${API}/api/accounts/${path}`, {
                method: 'POST',
                headers: {
                    Origin: 'hawconnect://',
                    'x-hawconnect-client': 'native',
                    'x-hawconnect-client-ip': crypto.randomUUID(),
                    Authorization: `Bearer ${bearer}`,
                    'Content-Type': 'application/json'
                },
                body: '{}'
            })
        )
    /** The login-site cookie no longer signs anyone in: authorize asks for sign-in, no code. */
    const expectSignedOutAtLogin = async (loginCookie: string) => {
        const { url } = flow('offline')
        const response = await authorize(url, loginCookie)
        expect(response.status).toBe(302)
        const location = locationOf(response)
        expect(`${location.origin}${location.pathname}`).toBe(
            `${LOGIN}/sign-in`
        )
        expect(location.searchParams.get('code')).toBeNull()
    }
    const providerRows = async (userId: string) => {
        const counts = await Promise.all(
            ['haw_oauth_refresh_token', 'haw_oauth_access_token'].map(
                async (table) =>
                    (
                        await pool.query(
                            `SELECT count(*)::int AS n FROM ${table} WHERE "userId" = $1 AND revoked IS NULL`,
                            [userId]
                        )
                    ).rows[0].n as number
            )
        )
        return counts.reduce((sum, n) => sum + n, 0)
    }

    beforeAll(async () => {
        const migration = await getMigrations(service.auth.options)
        await migration.runMigrations()
        const clients = [...(await loadConfiguredOidcClients(env)), OFFLINE]
        await syncOidcClients(service.auth, clients, env)
        app.use(
            loginHostGate(
                LOGIN,
                createLoginHost({
                    auth: service.auth,
                    actions: service.actions,
                    limited: service.limited,
                    clients,
                    loginOrigin: LOGIN
                })
            )
        )
        app.all('/api/accounts/*path', (req, res, next) => {
            req.headers['x-hawconnect-client-ip'] = req.ip ?? 'unknown'
            void toNodeHandler(service.handler)(req, res).catch(next)
        })
        server = app.listen(0, '127.0.0.1')
        await new Promise((resolve) => server.once('listening', resolve))
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })
    afterAll(async () => {
        setSystemTime()
        server?.close()
        await pool.end()
    })

    it('refuses a return address that is not exactly a registered one', async () => {
        const { email } = await confirmedUser()
        // Control: the exact registered address gets a code.
        const { loginCookie, redirect } = await signInAtLogin(
            flow('app').url,
            email
        )
        codeOf(redirect, APP_CALLBACK)
        for (const variant of [
            'http://localhost:4001/api/accounts/oidc/callback',
            'http://localhost/api/accounts/oidc/callback',
            'http://127.0.0.1:4000/api/accounts/oidc/callback',
            `${APP_CALLBACK}/`,
            `${APP_CALLBACK}?x=1`,
            'https://localhost:4000/api/accounts/oidc/callback',
            'hawconnect://auth/callback/',
            'hawconnect://auth/callback?x=1'
        ]) {
            // Signed in and anonymous alike: the error page of the login site, never the address.
            for (const cookie of [loginCookie, '']) {
                const response = await authorize(
                    flow('app', { redirect_uri: variant }).url,
                    cookie
                )
                const location = locationOf(response)
                expect({ variant, status: response.status }).toEqual({
                    variant,
                    status: 302
                })
                expect({
                    variant,
                    target: `${location.origin}${location.pathname}`
                }).toEqual({ variant, target: `${LOGIN}/error` })
                expect(location.searchParams.get('error')).toBe(
                    'invalid_redirect'
                )
                expect(location.searchParams.get('code')).toBeNull()
                expect(response.headers.get('location')).not.toStartWith(
                    variant
                )
            }
        }
    })

    it('requires PKCE with S256 and refuses the plain method', async () => {
        const { email } = await confirmedUser()
        const { loginCookie, redirect } = await signInAtLogin(
            flow('app').url,
            email
        )
        // Control: a signed-in person with an S256 challenge gets a code at once.
        codeOf(redirect, APP_CALLBACK)
        const { verifier } = pkce()
        for (const [name, extra] of [
            [
                'no challenge',
                { code_challenge: undefined, code_challenge_method: undefined }
            ],
            ['no method', { code_challenge_method: undefined }],
            [
                'plain',
                { code_challenge: verifier, code_challenge_method: 'plain' }
            ]
        ] as const) {
            const response = await authorize(
                flow('app', extra).url,
                loginCookie
            )
            const location = locationOf(response)
            expect({ name, status: response.status }).toEqual({
                name,
                status: 302
            })
            expect({ name, code: location.searchParams.get('code') }).toEqual({
                name,
                code: null
            })
            expect(location.searchParams.get('error')).toBe('invalid_request')
        }
    })

    it('a code works once; replaying it revokes the tokens of its first redemption', async () => {
        const person = await confirmedUser()
        const { url, verifier } = flow('offline')
        const { redirect } = await signInAtLogin(url, person.email)
        const code = codeOf(redirect, OFFLINE_CALLBACK)
        const first = await redeem(code, verifier)
        expect(first.status).toBe(200)
        const accessToken = first.body.access_token as string
        const refreshToken = first.body.refresh_token as string
        expect(refreshToken).toBeTruthy()
        expect((await userinfo(accessToken)).status).toBe(200)

        const replay = await redeem(code, verifier)
        expect(replay.status).toBe(400)
        expect(replay.body.error).toBe('invalid_grant')
        // The replay revoked what the first redemption issued.
        const refreshed = await refresh(refreshToken)
        expect(refreshed.status).toBe(400)
        expect(refreshed.body.error).toBe('invalid_grant')
        expect((await userinfo(accessToken)).status).toBe(401)
        expect(await providerRows(person.userId)).toBe(0)
    })

    it('a code expires after 60 seconds', async () => {
        const person = await confirmedUser()
        const { url, verifier } = flow('offline')
        const { loginCookie, redirect } = await signInAtLogin(url, person.email)
        const early = {
            code: codeOf(redirect, OFFLINE_CALLBACK),
            verifier
        }
        const late = await nextCode(loginCookie)
        const issued = Date.now()
        try {
            setSystemTime(new Date(issued + 58_000))
            expect((await redeem(early.code, early.verifier)).status).toBe(200)
            setSystemTime(new Date(issued + 61_000))
            const expired = await redeem(late.code, late.verifier)
            expect(expired.status).toBe(400)
            expect(expired.body.error).toBe('invalid_grant')
        } finally {
            setSystemTime()
        }
    })

    it('issues 900 s access and ID tokens and a 30-day refresh token', async () => {
        const person = await confirmedUser()
        const { url, verifier } = flow('offline')
        const { redirect } = await signInAtLogin(url, person.email)
        const tokens = await redeem(
            codeOf(redirect, OFFLINE_CALLBACK),
            verifier
        )
        expect(tokens.status).toBe(200)
        expect(tokens.body.expires_in).toBe(900)
        // The access token's own exp/iat, as the provider reports them.
        const introspect = await service.auth.handler(
            new Request(`${LOGIN}/api/auth/oauth2/introspect`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    token: tokens.body.access_token as string,
                    token_type_hint: 'access_token',
                    client_id: OFFLINE.clientId,
                    client_secret: OFFLINE_SECRET
                }).toString()
            })
        )
        const claims = (await introspect.json()) as {
            active: boolean
            exp: number
            iat: number
        }
        expect(claims.active).toBe(true)
        expect(claims.exp - claims.iat).toBe(900)
        const idToken = JSON.parse(
            Buffer.from(
                (tokens.body.id_token as string).split('.')[1] as string,
                'base64url'
            ).toString()
        ) as { exp: number; iat: number }
        expect(idToken.exp - idToken.iat).toBe(900)
        const { rows } = await pool.query(
            `SELECT "createdAt", "expiresAt", scopes FROM haw_oauth_refresh_token WHERE "userId" = $1`,
            [person.userId]
        )
        expect(rows).toHaveLength(1)
        expect(
            (rows[0].expiresAt.getTime() - rows[0].createdAt.getTime()) / 1000
        ).toBe(2_592_000)
    })

    it('rotates the refresh token on every use; an old one gives invalid_grant', async () => {
        const person = await personWithTokens()
        const rotated = await refresh(person.refreshToken)
        expect(rotated.status).toBe(200)
        const next = rotated.body.refresh_token as string
        expect(next).toBeTruthy()
        expect(next).not.toBe(person.refreshToken)
        expect(rotated.body.expires_in).toBe(900)

        const reused = await refresh(person.refreshToken)
        expect(reused.status).toBe(400)
        expect(reused.body.error).toBe('invalid_grant')
        // Reuse of a rotated token also ends the family it came from.
        const after = await refresh(next)
        expect(after.status).toBe(400)
        expect(after.body.error).toBe('invalid_grant')
    })

    it('deleting the account revokes every token and ends the login-site session', async () => {
        const person = await personWithTokens()
        const app = await createAppSession(service.auth, person.userId)
        const response = await nativeAccounts('delete-account', app.token)
        expect(response.status).toBe(200)

        const refreshed = await refresh(person.refreshToken)
        expect(refreshed.status).toBe(400)
        expect(refreshed.body.error).toBe('invalid_grant')
        expect((await userinfo(person.accessToken)).status).toBe(401)
        expect(await providerRows(person.userId)).toBe(0)
        await expectSignedOutAtLogin(person.loginCookie)
    })

    it('revoke-all revokes every token and ends the login-site session', async () => {
        const person = await personWithTokens()
        const app = await createAppSession(service.auth, person.userId)
        const response = await nativeAccounts('revoke-all', app.token)
        expect(response.status).toBe(200)

        const refreshed = await refresh(person.refreshToken)
        expect(refreshed.status).toBe(400)
        expect(refreshed.body.error).toBe('invalid_grant')
        expect((await userinfo(person.accessToken)).status).toBe(401)
        expect(await providerRows(person.userId)).toBe(0)
        await expectSignedOutAtLogin(person.loginCookie)
        // The account itself stays: the person can sign in again.
        const { redirect } = await signInAtLogin(
            flow('offline').url,
            person.email
        )
        codeOf(redirect, OFFLINE_CALLBACK)
    })

    it('a password reset revokes every token and ends the login-site session', async () => {
        const person = await personWithTokens()
        const asked = await service.actions.forgotPassword(person.email)
        expect(asked.ok).toBe(true)
        const mail = sent.findLast(
            (message) =>
                message.kind === 'reset' && message.email === person.email
        )
        const token = new URL(mail?.url ?? '').searchParams.get('token') ?? ''
        expect(token).toBeTruthy()
        const reset = await service.actions.resetPassword(
            token,
            'another horse 43 battery'
        )
        expect(reset.ok).toBe(true)

        const refreshed = await refresh(person.refreshToken)
        expect(refreshed.status).toBe(400)
        expect(refreshed.body.error).toBe('invalid_grant')
        expect((await userinfo(person.accessToken)).status).toBe(401)
        expect(await providerRows(person.userId)).toBe(0)
        await expectSignedOutAtLogin(person.loginCookie)
    })

    it('introspect and revoke answer 404 on both hosts', async () => {
        const person = await personWithTokens()
        const credentials = new URLSearchParams({
            token: person.accessToken,
            client_id: OFFLINE.clientId,
            client_secret: OFFLINE_SECRET
        }).toString()
        for (const host of [LOGIN_HOST, API_HOST])
            for (const path of [
                '/api/auth/oauth2/introspect',
                '/api/auth/oauth2/revoke'
            ])
                for (const method of ['POST', 'GET']) {
                    const response = await fetch(
                        `${base}${path}${method === 'GET' ? `?${credentials}` : ''}`,
                        {
                            method,
                            redirect: 'manual',
                            headers: {
                                Host: host,
                                ...(method === 'POST'
                                    ? {
                                          'Content-Type':
                                              'application/x-www-form-urlencoded'
                                      }
                                    : {})
                            },
                            body: method === 'POST' ? credentials : undefined
                        }
                    )
                    expect({
                        host,
                        path,
                        method,
                        status: response.status
                    }).toEqual({ host, path, method, status: 404 })
                }
        // Nothing was revoked through them.
        expect((await userinfo(person.accessToken)).status).toBe(200)
    })
})
