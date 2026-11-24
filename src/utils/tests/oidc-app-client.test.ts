import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { getMigrations } from 'better-auth/db/migration'
import { decodeJwt } from 'jose'
import { Pool } from 'pg'
import { createAccountAuth } from '../../lib/account-auth'
import { createAppSession } from '../../lib/app-session'
import { readLogoutTicket } from '../../lib/logout-ticket'
import { safeReturnPath } from '../../lib/oidc-app-client'
import {
    loadConfiguredOidcClients,
    oidcSecretVariable,
    syncOidcClients
} from '../../lib/oidc-clients'

const API = 'http://localhost:4000'
const LOGIN = 'http://account.localhost:4000'
const WEB = 'http://localhost:8081'
const SECRET = 'test-only-secret-with-at-least-thirty-two-characters'
const APP_SECRET = 'app-client-secret-with-at-least-thirty-two-chars'
const PASSWORD = 'correct horse 42 battery'
const NATIVE_REDIRECT = 'hawconnect://auth/callback'
const FAILED = `${WEB}/login?error=sign-in-failed`

describe('safeReturnPath', () => {
    it('keeps only plain absolute paths', () => {
        expect(safeReturnPath('/marketplace/abc')).toBe('/marketplace/abc')
        expect(safeReturnPath('/')).toBe('/')
        for (const value of [
            '//evil.example',
            'https://evil.example',
            '/\\evil',
            '/a?b',
            '/a#b',
            '/a b',
            'marketplace',
            '',
            undefined,
            null,
            42,
            ['/marketplace']
        ])
            expect(safeReturnPath(value)).toBe('/')
    })
})

const databaseURL = process.env.HAWCONNECT_TEST_DATABASE_URL
const suite = databaseURL ? describe : describe.skip
suite(
    'HAWConnect app as an OpenID Connect client (isolated PostgreSQL)',
    () => {
        const pool = new Pool({ connectionString: databaseURL })
        const env = {
            HAWCONNECT_AUTH_ORIGIN: API,
            HAWCONNECT_WEB_ORIGIN: WEB,
            [oidcSecretVariable('hawconnect-app')]: APP_SECRET
        }
        const service = createAccountAuth({
            pool,
            secret: SECRET,
            baseURL: API,
            loginOrigin: LOGIN,
            webOrigin: WEB,
            registration: true,
            appClientSecret: APP_SECRET,
            send: async () => {}
        })
        const base64url = (buffer: Buffer) => buffer.toString('base64url')
        const pairsOf = (response: Response) =>
            response.headers
                .getSetCookie()
                .map((cookie) => cookie.split(';')[0])
        const cookieHeader = (response: Response) =>
            pairsOf(response)
                .filter((pair) => !pair?.endsWith('='))
                .join('; ')
        const accounts = (
            path: string,
            options: {
                body?: unknown
                cookie?: string
                bearer?: string
                native?: boolean
                origin?: string | null
            } = {}
        ) => {
            const native = options.native || options.bearer !== undefined
            const origin =
                options.origin === undefined
                    ? native
                        ? 'hawconnect://'
                        : WEB
                    : options.origin
            return service.handler(
                new Request(`${API}/api/accounts/${path}`, {
                    method: options.body ? 'POST' : 'GET',
                    headers: {
                        ...(origin ? { Origin: origin } : {}),
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
                    ...(options.body
                        ? { body: JSON.stringify(options.body) }
                        : {})
                })
            )
        }
        const confirmedUser = async () => {
            const email = `app-${crypto.randomUUID()}@mail.example.org`
            await service.auth.api.signUpEmail({
                body: { email, password: PASSWORD, name: '' }
            })
            await pool.query(
                'UPDATE haw_user SET "emailVerified" = true WHERE email = $1',
                [email]
            )
            return email
        }
        /** The login-site session cookie of the last sign-in. */
        let loginCookie = ''
        /** The raw session token in the login-site cookie (before its signature). */
        const loginToken = () =>
            decodeURIComponent(
                loginCookie.match(/hawconnect\.session_token=([^;]*)/)?.[1] ??
                    ''
            ).split('.')[0]
        /** What the login site does: authorize sends the browser to /sign-in, the form signs in and continues. */
        const signInAtLogin = async (authorize: string, email: string) => {
            const first = await service.auth.handler(new Request(authorize))
            expect(first.status).toBe(302)
            const signInPage = new URL(
                first.headers.get('location') ?? '',
                LOGIN
            )
            expect(`${signInPage.origin}${signInPage.pathname}`).toBe(
                `${LOGIN}/sign-in`
            )
            const result = await service.actions.signIn(
                email,
                PASSWORD,
                new Headers({ origin: LOGIN }),
                signInPage.search.slice(1)
            )
            if (!result.ok) throw new Error(result.code)
            loginCookie = result.value.setCookie
                .map((cookie) => cookie.split(';')[0])
                .join('; ')
            return new URL(result.value.redirect ?? '')
        }
        /** Start on the API, sign in at the login site, return the callback URL and the state cookie. */
        const webSignIn = async (returnPath = '/marketplace') => {
            const email = await confirmedUser()
            const start = await accounts(
                `oidc/start?return=${encodeURIComponent(returnPath)}`,
                { origin: null }
            )
            expect(start.status).toBe(302)
            const authorize = start.headers.get('location') ?? ''
            const stateCookie = cookieHeader(start)
            const callback = await signInAtLogin(authorize, email)
            return { email, start, authorize, stateCookie, callback }
        }
        const callback = (url: URL, cookie: string) =>
            service.handler(
                new Request(`${API}${url.pathname}${url.search}`, {
                    headers: { cookie, 'x-hawconnect-client-ip': '127.0.0.1' }
                })
            )
        const expectFailure = (response: Response) => {
            expect(response.status).toBe(302)
            expect(response.headers.get('location')).toBe(FAILED)
            const cookies = response.headers.getSetCookie()
            expect(
                cookies.some(
                    (c) =>
                        c.includes('session_token=') &&
                        !c.includes('session_token=;')
                )
            ).toBe(false)
            expect(
                cookies.some(
                    (c) =>
                        c.startsWith('hawconnect.oidc_state=;') &&
                        c.includes('Max-Age=0')
                )
            ).toBe(true)
        }

        beforeAll(async () => {
            const migration = await getMigrations(service.auth.options)
            await migration.runMigrations()
            await syncOidcClients(
                service.auth,
                await loadConfiguredOidcClients(env),
                env
            )
        })
        afterAll(async () => {
            await pool.end()
        })

        it('web flow ends with a working app session', async () => {
            const {
                email,
                start,
                authorize,
                stateCookie,
                callback: url
            } = await webSignIn('/marketplace')
            const target = new URL(authorize)
            expect(`${target.origin}${target.pathname}`).toBe(
                `${LOGIN}/api/auth/oauth2/authorize`
            )
            expect(target.searchParams.get('client_id')).toBe('hawconnect-app')
            expect(target.searchParams.get('redirect_uri')).toBe(
                `${API}/api/accounts/oidc/callback`
            )
            expect(target.searchParams.get('response_type')).toBe('code')
            expect(target.searchParams.get('code_challenge_method')).toBe(
                'S256'
            )
            expect(target.searchParams.get('state')?.length).toBeGreaterThan(20)
            expect(target.searchParams.get('nonce')?.length).toBeGreaterThan(20)
            const set = start.headers.getSetCookie()
            expect(set).toHaveLength(1)
            expect(set[0]).toStartWith('hawconnect.oidc_state=')
            expect(set[0]).toContain('Path=/api/accounts/oidc')
            expect(set[0]).toContain('HttpOnly')
            expect(set[0]).toContain('SameSite=Lax')
            expect(set[0]).toContain('Max-Age=600')
            expect(url.searchParams.get('state')).toBe(
                target.searchParams.get('state')
            )
            expect(url.searchParams.get('iss')).toBe(LOGIN)

            const response = await callback(url, stateCookie)
            expect(response.status).toBe(302)
            expect(response.headers.get('location')).toBe(`${WEB}/marketplace`)
            const cookies = response.headers.getSetCookie()
            const session = cookies.find((c) =>
                c.startsWith('hawconnect.session_token=')
            )
            expect(session).toContain('HttpOnly')
            expect(session).toContain('Path=/')
            expect(
                cookies.some(
                    (c) =>
                        c.startsWith('hawconnect.oidc_state=;') &&
                        c.includes('Path=/api/accounts/oidc') &&
                        c.includes('Max-Age=0')
                )
            ).toBe(true)
            const body = await response.text()
            expect(body).not.toContain('eyJ')

            const check = await accounts('session', {
                cookie: session?.split(';')[0]
            })
            expect(check.status).toBe(200)
            const value = (await check.json()) as { user: { email: string } }
            expect(value.user.email).toBe(email)

            // No provider token is kept for the app: the access token was revoked.
            const { rows } = await pool.query(
                `SELECT t.id FROM haw_oauth_access_token t JOIN haw_user u ON u.id = t."userId" WHERE u.email = $1`,
                [email]
            )
            expect(rows).toHaveLength(0)
        })

        it('rejects a callback whose state does not match the cookie', async () => {
            const { stateCookie, callback: url } = await webSignIn()
            const tampered = new URL(url)
            tampered.searchParams.set('state', 'not-the-state')
            expectFailure(await callback(tampered, stateCookie))
            // The same code also fails without the cookie, with a forged cookie
            // and with another issuer.
            expectFailure(await callback(url, ''))
            const [name, value] = stateCookie.split('=') as [string, string]
            expectFailure(
                await callback(url, `${name}=${value.slice(0, -2)}xx`)
            )
            const otherIssuer = new URL(url)
            otherIssuer.searchParams.set('iss', 'https://evil.example')
            expectFailure(await callback(otherIssuer, stateCookie))
        })

        it('lands on sign-in for a provider error', async () => {
            const start = await accounts('oidc/start?return=/', {
                origin: null
            })
            const state = new URL(
                start.headers.get('location') ?? ''
            ).searchParams.get('state')
            const url = new URL(`${API}/api/accounts/oidc/callback`)
            url.searchParams.set('error', 'access_denied')
            url.searchParams.set('state', state ?? '')
            expectFailure(await callback(url, cookieHeader(start)))
        })

        it('a replayed callback lands on sign-in, not an error', async () => {
            const { stateCookie, callback: url } = await webSignIn()
            const first = await callback(url, stateCookie)
            expect(first.status).toBe(302)
            expect(first.headers.get('location')).toBe(`${WEB}/marketplace`)
            const session = pairsOf(first).find((c) =>
                c?.startsWith('hawconnect.session_token=')
            )
            expectFailure(await callback(url, stateCookie))
            expect(
                (await accounts('session', { cookie: session })).status
            ).toBe(200)
        })

        it('returns to the start page for an unsafe return path', async () => {
            const { stateCookie, callback: url } =
                await webSignIn('//evil.example')
            const response = await callback(url, stateCookie)
            expect(response.headers.get('location')).toBe(`${WEB}/`)
        })

        it('native exchange returns a bearer accepted by /session', async () => {
            const email = await confirmedUser()
            const verifier = base64url(randomBytes(32))
            const nonce = base64url(randomBytes(16))
            const authorize = new URL(`${LOGIN}/api/auth/oauth2/authorize`)
            authorize.search = new URLSearchParams({
                response_type: 'code',
                client_id: 'hawconnect-app',
                redirect_uri: NATIVE_REDIRECT,
                scope: 'openid email',
                state: base64url(randomBytes(16)),
                nonce,
                code_challenge: base64url(
                    createHash('sha256').update(verifier).digest()
                ),
                code_challenge_method: 'S256'
            }).toString()
            const redirect = await signInAtLogin(authorize.toString(), email)
            expect(
                `${redirect.protocol}//${redirect.host}${redirect.pathname}`
            ).toBe(NATIVE_REDIRECT)
            const code = redirect.searchParams.get('code') ?? ''
            const exchange = (body: Record<string, unknown>, native = true) =>
                accounts('oidc/exchange', {
                    body,
                    native,
                    origin: native ? 'hawconnect://' : WEB
                })
            const valid = {
                code,
                codeVerifier: verifier,
                redirectUri: NATIVE_REDIRECT,
                nonce
            }
            // Refusals before redemption leave the code usable.
            const wrong = await exchange({
                ...valid,
                redirectUri: `${API}/api/accounts/oidc/callback`
            })
            expect(wrong.status).toBe(400)
            expect(await wrong.json()).toEqual({ error: 'InvalidLink' })
            const missing = await exchange({
                ...valid,
                codeVerifier: undefined
            })
            expect(missing.status).toBe(400)
            expect((await exchange(valid, false)).status).toBe(403)

            const response = await exchange(valid)
            expect(response.status).toBe(200)
            const value = (await response.json()) as {
                user: { id: string; email: string }
                token: string
            }
            expect(Object.keys(value).sort()).toEqual(['token', 'user'])
            expect(value.user.email).toBe(email)
            expect(value.token.length).toBeGreaterThan(20)
            expect(value.token).not.toContain('.')
            const check = await accounts('session', { bearer: value.token })
            expect(check.status).toBe(200)
            expect(
                ((await check.json()) as { user: { id: string } }).user.id
            ).toBe(value.user.id)

            // The code is single-use.
            const again = await exchange(valid)
            expect(again.status).toBe(400)
        })

        it('native exchange checks the nonce', async () => {
            const email = await confirmedUser()
            const verifier = base64url(randomBytes(32))
            const authorize = new URL(`${LOGIN}/api/auth/oauth2/authorize`)
            authorize.search = new URLSearchParams({
                response_type: 'code',
                client_id: 'hawconnect-app',
                redirect_uri: NATIVE_REDIRECT,
                scope: 'openid email',
                state: 'state-value-native',
                nonce: 'the-real-nonce-value',
                code_challenge: base64url(
                    createHash('sha256').update(verifier).digest()
                ),
                code_challenge_method: 'S256'
            }).toString()
            const redirect = await signInAtLogin(authorize.toString(), email)
            const response = await accounts('oidc/exchange', {
                native: true,
                body: {
                    code: redirect.searchParams.get('code'),
                    codeVerifier: verifier,
                    redirectUri: NATIVE_REDIRECT,
                    nonce: 'another-nonce-value'
                }
            })
            expect(response.status).toBe(400)
            expect(await response.json()).toEqual({ error: 'InvalidLink' })
        })

        it('createAppSession gives a cookie and a bearer accepted by /session', async () => {
            const email = await confirmedUser()
            const { rows } = await pool.query(
                'SELECT id FROM haw_user WHERE email = $1',
                [email]
            )
            const created = await createAppSession(service.auth, rows[0].id)
            const cookie = created.setCookie
                .map((c) => c.split(';')[0])
                .join('; ')
            expect((await accounts('session', { cookie })).status).toBe(200)
            expect(
                (await accounts('session', { bearer: created.token })).status
            ).toBe(200)
        })

        it('sign-out returns the end-session URL with the registered post-logout address', async () => {
            const { stateCookie, callback: url } = await webSignIn()
            const session = pairsOf(await callback(url, stateCookie)).find(
                (c) => c?.startsWith('hawconnect.session_token=')
            )
            const response = await accounts('sign-out', {
                body: {},
                cookie: session
            })
            expect(response.status).toBe(200)
            const value = (await response.json()) as {
                success: boolean
                endSessionUrl: string
            }
            expect(value.success).toBe(true)
            const end = new URL(value.endSessionUrl)
            expect(`${end.origin}${end.pathname}`).toBe(
                `${LOGIN}/api/auth/oauth2/end-session`
            )
            expect(end.searchParams.get('client_id')).toBe('hawconnect-app')
            expect(end.searchParams.get('post_logout_redirect_uri')).toBe(
                `${WEB}/`
            )
            // The one-click ticket names the person who signed out, for 60 seconds.
            const signedOut = (
                await pool.query(
                    'SELECT "userId" FROM haw_session WHERE token = $1',
                    [loginToken()]
                )
            ).rows[0]?.userId
            expect(signedOut).toBeTruthy()
            expect(
                readLogoutTicket(SECRET, end.searchParams.get('ticket') ?? '')
            ).toBe(signedOut)
            expect(
                readLogoutTicket(
                    SECRET,
                    end.searchParams.get('ticket') ?? '',
                    Date.now() + 61_000
                )
            ).toBeNull()
            expect(
                (await accounts('session', { cookie: session })).status
            ).toBe(401)

            // Native callers get no end-session URL.
            const native = await createAppSession(
                service.auth,
                (await pool.query('SELECT "userId" FROM haw_session LIMIT 1'))
                    .rows[0].userId
            )
            const nativeOut = await accounts('sign-out', {
                body: {},
                bearer: native.token
            })
            expect(nativeOut.status).toBe(200)
            expect(await nativeOut.json()).toEqual({ success: true })
        })

        const nativeAuthorize = (verifier: string, nonce: string) => {
            const authorize = new URL(`${LOGIN}/api/auth/oauth2/authorize`)
            authorize.search = new URLSearchParams({
                response_type: 'code',
                client_id: 'hawconnect-app',
                redirect_uri: NATIVE_REDIRECT,
                scope: 'openid email',
                state: base64url(randomBytes(16)),
                nonce,
                prompt: 'login',
                code_challenge: base64url(
                    createHash('sha256').update(verifier).digest()
                ),
                code_challenge_method: 'S256'
            }).toString()
            return authorize.toString()
        }

        it('the ID token names the login-site session in sid', async () => {
            const email = await confirmedUser()
            const verifier = base64url(randomBytes(32))
            const nonce = base64url(randomBytes(16))
            const redirect = await signInAtLogin(
                nativeAuthorize(verifier, nonce),
                email
            )
            const response = await service.auth.handler(
                new Request(`${LOGIN}/api/auth/oauth2/token`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        code: redirect.searchParams.get('code') ?? '',
                        redirect_uri: NATIVE_REDIRECT,
                        client_id: 'hawconnect-app',
                        client_secret: APP_SECRET,
                        code_verifier: verifier
                    })
                })
            )
            expect(response.status).toBe(200)
            const { id_token } = (await response.json()) as { id_token: string }
            const claims = decodeJwt(id_token)
            const { rows } = await pool.query(
                'SELECT id, "userId" FROM haw_session WHERE token = $1',
                [loginToken()]
            )
            expect(claims.sid).toBe(rows[0].id)
            expect(claims.sub).toBe(rows[0].userId)
        })

        it('native exchange ends the login-site session it came from', async () => {
            const email = await confirmedUser()
            const verifier = base64url(randomBytes(32))
            const nonce = base64url(randomBytes(16))
            const redirect = await signInAtLogin(
                nativeAuthorize(verifier, nonce),
                email
            )
            const cookie = loginCookie
            // Another login-site session of the same person (e.g. another browser) stays.
            const other = await service.actions.signIn(
                email,
                PASSWORD,
                new Headers({ origin: LOGIN })
            )
            if (!other.ok) throw new Error(other.code)
            const response = await accounts('oidc/exchange', {
                native: true,
                body: {
                    code: redirect.searchParams.get('code'),
                    codeVerifier: verifier,
                    redirectUri: NATIVE_REDIRECT,
                    nonce
                }
            })
            expect(response.status).toBe(200)
            // The phone's browser cookie no longer signs anyone in: authorize asks again.
            const again = await service.auth.handler(
                new Request(
                    `${LOGIN}/api/auth/oauth2/authorize?${new URLSearchParams({
                        response_type: 'code',
                        client_id: 'hawconnect-app',
                        redirect_uri: NATIVE_REDIRECT,
                        scope: 'openid email',
                        state: 'after-exchange',
                        nonce: 'after-exchange-nonce',
                        code_challenge: base64url(
                            createHash('sha256').update(verifier).digest()
                        ),
                        code_challenge_method: 'S256'
                    })}`,
                    { headers: { cookie, Accept: 'text/html' } }
                )
            )
            expect(again.status).toBe(302)
            const location = new URL(again.headers.get('location') ?? '', LOGIN)
            expect(`${location.origin}${location.pathname}`).toBe(
                `${LOGIN}/sign-in`
            )
            const otherCookie = other.value.setCookie
                .map((line) => line.split(';')[0])
                .join('; ')
            const still = await service.auth.handler(
                new Request(`${LOGIN}/api/auth/get-session`, {
                    headers: { cookie: otherCookie }
                })
            )
            expect(
                ((await still.json()) as { user?: { email: string } } | null)
                    ?.user?.email
            ).toBe(email)
        })

        it('limits the browser sign-in routes per address', async () => {
            const ip = `oidc-get-${crypto.randomUUID()}`
            const statuses: number[] = []
            for (let index = 0; index < 31; index++)
                statuses.push(
                    (
                        await service.handler(
                            new Request(
                                `${API}/api/accounts/oidc/start?return=/`,
                                {
                                    headers: { 'x-hawconnect-client-ip': ip }
                                }
                            )
                        )
                    ).status
                )
            expect(statuses.slice(0, 30)).not.toContain(429)
            expect(statuses[30]).toBe(429)
        })
    }
)
