import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
    setSystemTime
} from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { get as httpGet, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { getMigrations } from 'better-auth/db/migration'
import { toNodeHandler } from 'better-auth/node'
import express from 'express'
import { Pool } from 'pg'
import { type AccountMail, createAccountAuth } from '../../lib/account-auth'
import { createLogoutTicket } from '../../lib/logout-ticket'
import { parseOidcClients, syncOidcClients } from '../../lib/oidc-clients'
import { copies, languageOf, resolveLanguage, themeOf } from '../copy'
import {
    checkEmailPage,
    confirmPage,
    createAccountPage,
    forgotPasswordPage,
    noticePage,
    type PageContext,
    resetPasswordPage,
    signInPage,
    signOutPage
} from '../pages'
import {
    createLoginHost,
    loginHostGate,
    safeNext,
    unavailableLoginHost
} from '../router'

const LOGIN = 'http://account.localhost:4000'
const LOGIN_HOST = 'account.localhost:4000'
const API_HOST = 'localhost:4000'
const API = 'http://localhost:4000'
const WEB = 'http://localhost:3001'
const SECRET = 'test-only-secret-with-at-least-thirty-two-characters'
const CSP =
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self' hawconnect: http://localhost:3001 http://localhost:4000"
const ENV = {
    HAWCONNECT_AUTH_ORIGIN: 'http://localhost:4000',
    HAWCONNECT_WEB_ORIGIN: 'http://localhost:3001',
    HAWCONNECT_OIDC_SECRET_HAWCONNECT_APP:
        'client-secret-with-at-least-thirty-two-chars'
}
const CALLBACK = 'http://localhost:4000/api/accounts/oidc/callback'
const PASSWORD = 'correct horse 42 battery'
const VERIFIER = 'login-site-test-verifier-'.padEnd(64, 'v')
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')
const PAGES = [
    '/sign-in',
    '/create-account',
    '/check-email',
    '/confirm?token=0123456789abcdef0123',
    '/forgot-password',
    '/reset-password?token=0123456789abcdef0123',
    '/signed-out',
    '/consent',
    '/error'
]
const PROVIDER: [string, string][] = [
    ['GET', '/.well-known/openid-configuration'],
    ['GET', '/api/auth/oauth2/authorize'],
    ['POST', '/api/auth/oauth2/token'],
    ['GET', '/api/auth/oauth2/userinfo'],
    ['GET', '/api/auth/jwks'],
    ['GET', '/api/auth/oauth2/end-session']
]
const shipped = JSON.parse(
    readFileSync(
        new URL('../../../config/oidc-clients.json', import.meta.url),
        'utf8'
    )
)

const databaseURL = process.env.HAWCONNECT_TEST_DATABASE_URL
const suite = databaseURL ? describe : describe.skip
suite('login site (isolated PostgreSQL)', () => {
    const pool = new Pool({ connectionString: databaseURL })
    const sent: AccountMail[] = []
    const service = createAccountAuth({
        pool,
        secret: SECRET,
        baseURL: API,
        loginOrigin: LOGIN,
        webOrigin: WEB,
        registration: true,
        appClientSecret: ENV.HAWCONNECT_OIDC_SECRET_HAWCONNECT_APP,
        send: async (message) => {
            sent.push(message)
        }
    })
    const clients = parseOidcClients(shipped, ENV)
    const app = express()
    // Every test request comes from its own address so the per-IP form limit stays per test.
    app.set('trust proxy', true)
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
    // Stand-ins for the API host's routes in index.ts.
    app.all('/graphql', (_req, res) => {
        res.json({ data: null })
    })
    // The real account routes, wrapped as in index.ts (the web sign-in returns here).
    app.all('/api/accounts/*path', (req, res, next) => {
        req.headers['x-hawconnect-client-ip'] = req.ip ?? 'unknown'
        void toNodeHandler(service.handler)(req, res).catch(next)
    })
    let server: Server
    let base: string

    type Options = {
        host?: string
        method?: string
        form?: Record<string, string>
        cookie?: string
        origin?: string | null
        ip?: string
        headers?: Record<string, string>
    }
    const call = (path: string, options: Options = {}) => {
        const method = options.method ?? (options.form ? 'POST' : 'GET')
        const headers: Record<string, string> = {
            Host: options.host ?? LOGIN_HOST,
            'X-Forwarded-For': options.ip ?? `198.51.100.${randomByte()}`,
            ...options.headers
        }
        if (options.form)
            headers['Content-Type'] = 'application/x-www-form-urlencoded'
        // The Origin is explicit per request; the login origin is sent the way a
        // browser sends a same-origin form post (fetch metadata included).
        if (options.origin) headers.Origin = options.origin
        if (options.origin === LOGIN)
            Object.assign(headers, {
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Dest': 'document',
                Accept: 'text/html,application/xhtml+xml',
                ...options.headers
            })
        if (options.cookie) headers.Cookie = options.cookie
        return fetch(`${base}${path}`, {
            method,
            redirect: 'manual',
            headers,
            body: options.form
                ? new URLSearchParams(options.form).toString()
                : undefined
        })
    }
    const randomByte = () => Math.floor(Math.random() * 250) + 1
    const cookiesOf = (response: Response, previous = '') => {
        const jar = new Map(
            previous
                .split('; ')
                .filter(Boolean)
                .map((pair) => pair.split(/=(.*)/s).slice(0, 2) as string[])
        )
        for (const line of response.headers.getSetCookie()) {
            const [pair] = line.split(';')
            const [name, value] = pair.split(/=(.*)/s)
            if (/max-age=0/i.test(line) || value === '') jar.delete(name)
            else jar.set(name, value)
        }
        return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    }
    const decodeEntities = (value: string) =>
        value
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
    const hidden = (page: string, name: string) => {
        const match = page.match(new RegExp(`name="${name}" value="([^"]*)"`))
        return match ? decodeEntities(match[1]) : null
    }
    const address = (name: string) =>
        `${name}-${crypto.randomUUID()}@mail.example.org`
    const confirmedUser = async (email: string) => {
        await service.auth.api.signUpEmail({
            body: { email, password: PASSWORD, name: '' }
        })
        await pool.query(
            'UPDATE haw_user SET "emailVerified" = true WHERE email = $1',
            [email]
        )
    }
    const authorize = (state: string, extra: Record<string, string> = {}) =>
        `/api/auth/oauth2/authorize?${new URLSearchParams({
            response_type: 'code',
            client_id: 'hawconnect-app',
            redirect_uri: CALLBACK,
            scope: 'openid email',
            state,
            code_challenge: CHALLENGE,
            code_challenge_method: 'S256',
            ...extra
        })}`
    /** Starts a flow the way a client does and returns the sign-in page's signed query. */
    const startFlow = async (
        state: string,
        cookie?: string,
        extra: Record<string, string> = {}
    ) => {
        const response = await call(authorize(state, extra), {
            cookie,
            headers: { Accept: 'text/html' }
        })
        expect(response.status).toBe(302)
        const location = new URL(response.headers.get('location') ?? '', LOGIN)
        expect(location.origin).toBe(LOGIN)
        expect(location.pathname).toBe('/sign-in')
        return location.search.slice(1)
    }
    const expectCode = (response: Response, state: string) => {
        expect(response.status).toBe(302)
        const location = new URL(response.headers.get('location') ?? '')
        expect(`${location.origin}${location.pathname}`).toBe(CALLBACK)
        expect(location.searchParams.get('code')).toBeTruthy()
        expect(location.searchParams.get('state')).toBe(state)
        return location.searchParams.get('code') as string
    }
    const mailToken = (kind: AccountMail['kind']) => {
        const mail = sent.findLast((message) => message.kind === kind)
        return new URL(mail?.url ?? '').searchParams.get('token') as string
    }

    const mailCode = () =>
        sent.findLast((message) => message.kind === 'verify')?.code ?? ''

    beforeAll(async () => {
        const migration = await getMigrations(service.auth.options)
        await migration.runMigrations()
        await syncOidcClients(service.auth, clients, ENV)
        server = app.listen(0, '127.0.0.1')
        await new Promise((resolve) => server.once('listening', resolve))
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    })
    afterAll(async () => {
        setSystemTime()
        server?.close()
        await pool.end()
    })

    it('serves only the allow-listed provider routes on the login host', async () => {
        for (const [method, path] of PROVIDER) {
            const response = await call(path, { method })
            expect({ path, status: response.status }).not.toEqual({
                path,
                status: 404
            })
        }
        for (const [method, path] of [
            ['GET', '/api/auth/get-session'],
            ['POST', '/api/auth/sign-in/email'],
            ['POST', '/api/auth/sign-up/email'],
            ['POST', '/api/auth/oauth2/introspect'],
            ['POST', '/api/auth/oauth2/revoke'],
            ['POST', '/api/auth/oauth2/continue'],
            ['POST', '/api/auth/oauth2/consent'],
            ['POST', '/api/auth/oauth2/create-client'],
            ['GET', '/api/auth/error'],
            // The add-on's own logout confirmation is never reachable.
            ['POST', '/api/auth/oauth2/end-session/confirm'],
            ['GET', '/api/auth/oauth2/token'],
            ['GET', '/api/auth/oauth2/authorize/'],
            ['GET', '/API/auth/jwks'],
            ['GET', '/.well-known/oauth-authorization-server'],
            ['POST', '/graphql'],
            ['GET', '/api/accounts/session'],
            ['GET', '/']
        ]) {
            const response = await call(path, {
                method,
                headers:
                    method === 'POST'
                        ? { 'Content-Type': 'application/json' }
                        : {}
            })
            expect({ path, status: response.status }).toEqual({
                path,
                status: 404
            })
        }
        // None of the login pages, and none of the provider routes, answer on the API host.
        for (const path of [...PAGES, '/sign-out', '/login.css'])
            expect({
                path,
                status: (await call(path, { host: API_HOST })).status
            }).toEqual({ path, status: 404 })
        for (const [method, path] of PROVIDER)
            expect({
                path,
                status: (await call(path, { method, host: API_HOST })).status
            }).toEqual({ path, status: 404 })
        // Today's API routes still answer on the API host.
        expect((await call('/graphql', { host: API_HOST })).status).toBe(200)
    })

    it('serves the self-hosted font with the exact content security policy', async () => {
        const response = await call('/fonts/outfit-latin-400-normal.woff2')
        expect(response.status).toBe(200)
        expect(response.headers.get('content-security-policy')).toBe(CSP)
    })

    it('sends security headers on every page', async () => {
        const query = await startFlow('headers')
        for (const path of [...PAGES, `/sign-in?${query}`, '/login.css']) {
            const response = await call(path)
            // form-action covers every hop of every form post: the login site, the
            // registered return addresses and the registered post-logout addresses.
            expect(response.headers.get('content-security-policy')).toBe(CSP)
            expect(response.headers.get('x-powered-by')).toBeNull()
            // same-origin keeps the real Origin on the pages' own form posts.
            expect(response.headers.get('referrer-policy')).toBe('same-origin')
            expect(response.headers.get('x-content-type-options')).toBe(
                'nosniff'
            )
            const body = await response.text()
            expect(body.toLowerCase()).not.toContain('<script')
            if (path === '/login.css') {
                expect(response.headers.get('cache-control')).toContain(
                    'max-age=31536000'
                )
                expect(response.headers.get('content-type')).toContain(
                    'text/css'
                )
            } else {
                expect(response.headers.get('cache-control')).toBe('no-store')
                expect(response.headers.get('content-type')).toContain(
                    'text/html'
                )
                // Nothing is loaded from another site.
                // (Plain links such as the terms and privacy pages are not loads.)
                expect(body).not.toMatch(/src="(https?:)?\/\//)
                expect(body).not.toMatch(/<link[^>]+href="(https?:)?\/\//)
            }
        }
        expect((await call('/consent')).status).toBe(403)
    })

    it('escapes every interpolated value', async () => {
        const response = await call('/sign-in', {
            origin: LOGIN,
            form: { email: '"><b>x</b>', password: 'wrong-password' }
        })
        expect(response.status).toBe(401)
        const body = await response.text()
        expect(body).not.toContain('<b>x</b>')
        expect(body).toContain('&quot;&gt;&lt;b&gt;x&lt;/b&gt;')
    })

    it('rejects a POST without the login Origin', async () => {
        for (const path of [
            '/sign-in',
            '/create-account',
            '/confirm',
            '/forgot-password',
            '/reset-password',
            '/check-email',
            '/sign-out'
        ]) {
            for (const origin of [
                null,
                'null',
                'http://evil.example',
                ENV.HAWCONNECT_WEB_ORIGIN
            ])
                expect({
                    path,
                    origin,
                    status: (
                        await call(path, {
                            form: { email: 'a@example.org', password: 'x' },
                            origin
                        })
                    ).status
                }).toEqual({ path, origin, status: 403 })
        }
    })

    it('limits form posts per address', async () => {
        const ip = `203.0.113.${randomByte()}`
        const statuses: number[] = []
        for (let index = 0; index < 21; index++)
            statuses.push(
                (
                    await call('/forgot-password', {
                        origin: LOGIN,
                        form: { email: 'not-an-email' },
                        ip
                    })
                ).status
            )
        expect(statuses.slice(0, 20)).not.toContain(429)
        expect(statuses[20]).toBe(429)
    })

    it('shows the terms and privacy notice instead of the old footer', async () => {
        const page = async (language: string) =>
            (
                await call('/sign-in', {
                    headers: { 'Accept-Language': language }
                })
            ).text()
        const english = await page('en')
        expect(english).toContain(
            'By continuing, you agree to our <a href="https://hawconnect.de/en/legal/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a> and <a href="https://hawconnect.de/en/legal/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.'
        )
        expect(english).not.toContain('myHAW login')
        const german = await page('de')
        expect(german).toContain(
            'Wenn du fortfährst, stimmst du unseren <a href="https://hawconnect.de/de/legal/terms" target="_blank" rel="noopener noreferrer">Nutzungsbedingungen</a> und der <a href="https://hawconnect.de/de/legal/privacy" target="_blank" rel="noopener noreferrer">Datenschutzerklärung</a> zu.'
        )
        expect(german).not.toContain('myHAW-Login')
    })

    it('create an account asks for a name and saves it', async () => {
        const page = await (
            await call('/create-account', {
                headers: { 'Accept-Language': 'en' }
            })
        ).text()
        expect(page).toContain('<h1>Create an account</h1>')
        expect(page).not.toContain('class="subtitle"')
        expect(page).toContain('name="name"')
        expect(page).toContain('autocomplete="name"')
        const email = address('named')
        const missing = await call('/create-account', {
            origin: LOGIN,
            headers: { 'Accept-Language': 'en' },
            form: { name: '  ', email, password: PASSWORD, confirm: PASSWORD }
        })
        expect(missing.status).toBe(400)
        expect(await missing.text()).toContain('Enter your name.')
        const created = await call('/create-account', {
            origin: LOGIN,
            form: {
                name: '  Grace Hopper ',
                email,
                password: PASSWORD,
                confirm: PASSWORD
            }
        })
        expect(created.status).toBe(303)
        const row = await pool.query(
            'SELECT name FROM haw_user WHERE email = $1',
            [email]
        )
        expect(row.rows[0]?.name).toBe('Grace Hopper')
    })

    it('follows the browser language', async () => {
        const page = async (language?: string) =>
            (
                await call('/sign-in', {
                    headers: language ? { 'Accept-Language': language } : {}
                })
            ).text()
        const english = await page('en-US,en;q=0.9,de;q=0.8')
        expect(english).toContain('<html lang="en">')
        expect(english).toContain('Sign in')
        expect(english).not.toContain('class="subtitle"')
        expect(await page('fr-FR, en;q=0.5')).toContain('<html lang="en">')
        const german = await page('de-DE,de;q=0.9,en;q=0.8')
        expect(german).toContain('<html lang="de">')
        expect(german).toContain('Anmelden')
        expect(german).not.toContain('class="subtitle"')
        // Without a supported language the default is English.
        expect(await page('fr')).toContain('<html lang="en">')
        expect(await page()).toContain('<html lang="en">')
    })

    it('full first-party flow', async () => {
        const email = address('flow')
        await confirmedUser(email)
        const query = await startFlow('state-full')
        const page = await call(`/sign-in?${query}`, {
            headers: { 'Accept-Language': 'en' }
        })
        expect(page.status).toBe(200)
        const body = await page.text()
        expect(body).not.toContain('to HAWConnect App')
        expect(hidden(body, 'oauth_query')).toBe(query)
        const signedIn = await call('/sign-in', {
            origin: LOGIN,
            form: { email, password: PASSWORD, oauth_query: query }
        })
        const code = expectCode(signedIn, 'state-full')
        const session = signedIn.headers
            .getSetCookie()
            .find((line) => line.startsWith('hawconnect.session_token='))
        expect(session).toBeTruthy()
        expect(session).not.toMatch(/domain=/i)
        expect(session).toMatch(/httponly/i)
        // The code is redeemable at the token endpoint on the login host.
        const token = await call('/api/auth/oauth2/token', {
            form: {
                grant_type: 'authorization_code',
                code,
                redirect_uri: CALLBACK,
                client_id: 'hawconnect-app',
                client_secret: ENV.HAWCONNECT_OIDC_SECRET_HAWCONNECT_APP,
                code_verifier: VERIFIER
            }
        })
        expect(token.status).toBe(200)
        expect(
            ((await token.json()) as { id_token?: string }).id_token
        ).toBeTruthy()
    })

    it('returns at once when already signed in at the login site', async () => {
        const email = address('again')
        await confirmedUser(email)
        const query = await startFlow('first')
        const first = await call('/sign-in', {
            origin: LOGIN,
            form: { email, password: PASSWORD, oauth_query: query }
        })
        expectCode(first, 'first')
        const cookie = cookiesOf(first)
        const second = await call(authorize('second'), {
            cookie,
            headers: { Accept: 'text/html' }
        })
        expectCode(second, 'second')
    })

    it('restarts an expired authorize request', async () => {
        const email = address('expired')
        await confirmedUser(email)
        const query = await startFlow('stale')
        try {
            setSystemTime(new Date(Date.now() + 5 * 60 * 1000))
            // Reloading the page restarts at once.
            const reload = await call(`/sign-in?${query}`)
            expect(reload.status).toBe(302)
            const reloaded = new URL(reload.headers.get('location') ?? '')
            expect(`${reloaded.origin}${reloaded.pathname}`).toBe(
                `${LOGIN}/api/auth/oauth2/authorize`
            )
            // A wrong password keeps the person on the page, flow kept.
            const wrong = await call('/sign-in', {
                origin: LOGIN,
                form: { email, password: 'wrong-password', oauth_query: query }
            })
            expect(wrong.status).toBe(401)
            expect(hidden(await wrong.text(), 'oauth_query')).toBe(query)
            // The right password signs in and restarts from the client's authorize URL.
            const submitted = await call('/sign-in', {
                origin: LOGIN,
                form: { email, password: PASSWORD, oauth_query: query }
            })
            expect(submitted.status).toBe(302)
            const restart = new URL(submitted.headers.get('location') ?? '')
            expect(`${restart.origin}${restart.pathname}`).toBe(
                `${LOGIN}/api/auth/oauth2/authorize`
            )
            expect(Object.fromEntries(restart.searchParams)).toEqual({
                response_type: 'code',
                client_id: 'hawconnect-app',
                redirect_uri: CALLBACK,
                scope: 'openid email',
                state: 'stale',
                code_challenge: CHALLENGE,
                code_challenge_method: 'S256'
            })
            const fresh = await call(`${restart.pathname}${restart.search}`, {
                cookie: cookiesOf(submitted),
                headers: { Accept: 'text/html' }
            })
            expectCode(fresh, 'stale')
        } finally {
            setSystemTime()
        }
    })

    it('switches language in the middle of a sign-in and keeps the flow', async () => {
        const query = await startFlow('lang-switch')
        const german = await call(`/sign-in?${query}`, {
            headers: { 'Accept-Language': 'de' }
        })
        const html = await german.text()
        expect(html).toContain('aria-current="true">Deutsch</span>')
        const href = html.match(/<a lang="en" href="([^"]+)">English<\/a>/)?.[1]
        expect(href).toBeDefined()
        const link = String(href).replaceAll('&amp;', '&')
        const switched = await call(link, {
            headers: { 'Accept-Language': 'de' }
        })
        expect(switched.status).toBe(303)
        const cookie = (switched.headers.get('set-cookie') ?? '').split(';')[0]
        expect(cookie).toBe('hawconnect-login-lang=en')
        const location = switched.headers.get('location') ?? ''
        expect(location.startsWith('/sign-in?oauth_query=')).toBe(true)
        const english = await call(location, {
            cookie,
            headers: { 'Accept-Language': 'de' }
        })
        const page = await english.text()
        expect(page).toContain('aria-current="true">English</span>')
        expect(page).toContain('Sign in')
        // The flow is still carried: the form keeps its signed query.
        expect(page).toContain('name="oauth_query"')
        // The language route answers on the login host only.
        expect((await call('/language?to=en', { host: API_HOST })).status).toBe(
            404
        )
    })

    it('shows the language and theme controls only on the form pages', async () => {
        const headers = { 'Accept-Language': 'en' }
        for (const path of [
            '/sign-in',
            '/create-account',
            '/check-email',
            '/forgot-password',
            '/confirm?token=0123456789abcdef0123',
            '/reset-password?token=0123456789abcdef0123'
        ])
            expect({
                path,
                controls: (
                    await (await call(path, { headers })).text()
                ).includes('<div class="controls">')
            }).toEqual({ path, controls: true })
        for (const path of [
            '/nope',
            '/error',
            '/signed-out',
            '/consent',
            '/confirm'
        ])
            expect({
                path,
                controls: (
                    await (await call(path, { headers })).text()
                ).includes('class="controls"')
            }).toEqual({ path, controls: false })
    })

    it('shows the error page for an unregistered redirect address in an expired request', async () => {
        const query = await startFlow('tampered')
        const params = new URLSearchParams(query)
        params.set('redirect_uri', 'https://evil.example/cb')
        const response = await call(`/sign-in?${params}`)
        expect(response.status).toBe(400)
        expect(response.headers.get('location')).toBeNull()
        expect(await response.text()).not.toContain('evil.example')
    })

    it('continues the original service after confirming', async () => {
        const email = address('confirm')
        const query = await startFlow('after-confirm')
        const created = await call('/create-account', {
            origin: LOGIN,
            form: {
                name: 'Ada Lovelace',
                email,
                password: PASSWORD,
                confirm: PASSWORD,
                oauth_query: query
            }
        })
        expect(created.status).toBe(303)
        const checkEmail = await call(created.headers.get('location') ?? '')
        expect(checkEmail.status).toBe(200)
        expect(hidden(await checkEmail.text(), 'oauth_query')).toBe(query)
        // Signing in before confirming shows the notice and a resend button.
        const early = await call('/sign-in', {
            origin: LOGIN,
            form: { email, password: PASSWORD, oauth_query: query },
            headers: { 'Accept-Language': 'en' }
        })
        expect(early.status).toBe(200)
        const notice = await early.text()
        expect(notice).toContain('Confirm your email address first.')
        expect(notice).toContain('Send a new code')
        expect(notice).toContain('action="/check-email"')
        expect(hidden(notice, 'oauth_query')).toBe(query)
        const cookie = cookiesOf(early)
        const resent = await call('/check-email', {
            origin: LOGIN,
            form: { email, oauth_query: query }
        })
        expect(resent.status).toBe(200)
        // The mail link carries only the token; the flow comes back from this browser.
        const token = mailToken('verify')
        const confirmPage = await call(
            `/confirm?token=${encodeURIComponent(token)}`,
            { cookie }
        )
        expect(confirmPage.status).toBe(200)
        const confirmBody = await confirmPage.text()
        expect(hidden(confirmBody, 'token')).toBe(token)
        expect(hidden(confirmBody, 'oauth_query')).toBe(query)
        const confirmed = await call('/confirm', {
            origin: LOGIN,
            form: { token, oauth_query: query },
            cookie
        })
        expect(confirmed.status).toBe(200)
        const signInPage = await confirmed.text()
        expect(hidden(signInPage, 'oauth_query')).toBe(query)
        const signedIn = await call('/sign-in', {
            origin: LOGIN,
            form: { email, password: PASSWORD, oauth_query: query },
            cookie
        })
        expectCode(signedIn, 'after-confirm')
    })

    it('confirms the email with the 6-digit code from the mail', async () => {
        const email = address('code')
        const query = await startFlow('after-code')
        const created = await call('/create-account', {
            origin: LOGIN,
            form: {
                name: 'Ada Lovelace',
                email,
                password: PASSWORD,
                confirm: PASSWORD,
                oauth_query: query
            }
        })
        expect(created.status).toBe(303)
        const cookie = cookiesOf(created)
        // The mail carries a code and still the confirm link.
        const code = mailCode()
        expect(code).toMatch(/^\d{6}$/)
        expect(mailToken('verify')).toBeTruthy()
        // The page after sign-up asks for the code, not the email address.
        const page = await call(created.headers.get('location') ?? '', {
            cookie,
            headers: { 'Accept-Language': 'en' }
        })
        expect(page.status).toBe(200)
        const body = await page.text()
        expect(body).toContain('action="/verify-code"')
        expect(body).toContain('autocomplete="one-time-code"')
        expect(body).toContain('Send a new code')
        expect(body).not.toContain('type="email"')
        expect(hidden(body, 'email')).toBe(email)
        expect(hidden(body, 'oauth_query')).toBe(query)

        const wrong = await call('/verify-code', {
            origin: LOGIN,
            form: {
                email,
                code: code === '000000' ? '111111' : '000000',
                oauth_query: query
            },
            cookie,
            headers: { 'Accept-Language': 'en' }
        })
        expect(wrong.status).toBe(400)
        const wrongBody = await wrong.text()
        expect(wrongBody).toContain('This code is wrong or has expired.')
        expect(hidden(wrongBody, 'email')).toBe(email)

        const confirmed = await call('/verify-code', {
            origin: LOGIN,
            form: { email, code, oauth_query: query },
            cookie,
            headers: { 'Accept-Language': 'en' }
        })
        expect(confirmed.status).toBe(200)
        const signInPage = await confirmed.text()
        expect(signInPage).toContain('Your email address is confirmed.')
        expect(hidden(signInPage, 'oauth_query')).toBe(query)
        const signedIn = await call('/sign-in', {
            origin: LOGIN,
            form: { email, password: PASSWORD, oauth_query: query },
            cookie
        })
        expectCode(signedIn, 'after-code')
    })

    it('a code stops working after 5 wrong tries; a new one works', async () => {
        const email = address('code-tries')
        await call('/create-account', {
            origin: LOGIN,
            form: {
                name: 'Ada Lovelace',
                email,
                password: PASSWORD,
                confirm: PASSWORD
            }
        })
        const code = mailCode()
        const other = code === '000000' ? '111111' : '000000'
        for (let i = 0; i < 5; i++)
            await call('/verify-code', {
                origin: LOGIN,
                form: { email, code: other }
            })
        const late = await call('/verify-code', {
            origin: LOGIN,
            form: { email, code }
        })
        expect(late.status).toBe(400)

        const resent = await call('/check-email', {
            origin: LOGIN,
            form: { email }
        })
        expect(resent.status).toBe(200)
        const fresh = mailCode()
        expect(fresh).not.toBe('')
        const confirmed = await call('/verify-code', {
            origin: LOGIN,
            form: { email, code: fresh }
        })
        expect(confirmed.status).toBe(200)
    }, 30_000)

    it('rejects codes that are not 6 digits without trying them', async () => {
        const email = address('code-shape')
        for (const code of ['', '12345', '1234567', 'abcdef'])
            expect(
                (
                    await call('/verify-code', {
                        origin: LOGIN,
                        form: { email, code }
                    })
                ).status
            ).toBe(400)
    })

    it('GET /confirm?token=… does not consume the token; POST does', async () => {
        const email = address('scanner')
        const created = await call('/create-account', {
            origin: LOGIN,
            form: {
                name: 'Ada Lovelace',
                email,
                password: PASSWORD,
                confirm: PASSWORD
            }
        })
        expect(created.status).toBe(303)
        const token = mailToken('verify')
        const verified = async () =>
            (
                await pool.query(
                    'SELECT "emailVerified" FROM haw_user WHERE email = $1',
                    [email]
                )
            ).rows[0].emailVerified
        for (let index = 0; index < 2; index++)
            expect(
                (await call(`/confirm?token=${encodeURIComponent(token)}`))
                    .status
            ).toBe(200)
        expect(await verified()).toBe(false)
        expect(
            (await call('/confirm', { origin: LOGIN, form: { token } })).status
        ).toBe(200)
        expect(await verified()).toBe(true)
        // better-auth's confirm token is a signed JWT, so using it again only
        // confirms the same address again; a forged token is refused.
        const forged = await call('/confirm', {
            origin: LOGIN,
            form: { token: `${token.slice(0, -4)}AAAA` },
            headers: { 'Accept-Language': 'en' }
        })
        expect(forged.status).toBe(400)
        expect(await forged.text()).toContain('This link is invalid')
    })

    it('resets a password only on POST', async () => {
        const email = address('reset')
        await confirmedUser(email)
        const asked = await call('/forgot-password', {
            origin: LOGIN,
            form: { email }
        })
        expect(asked.status).toBe(200)
        const token = mailToken('reset')
        const page = await call(
            `/reset-password?token=${encodeURIComponent(token)}`
        )
        expect(page.status).toBe(200)
        expect(hidden(await page.text(), 'token')).toBe(token)
        const mismatch = await call('/reset-password', {
            origin: LOGIN,
            form: { token, password: 'new password 123', confirm: 'other' },
            headers: { 'Accept-Language': 'en' }
        })
        expect(mismatch.status).toBe(400)
        const mismatchHtml = await mismatch.text()
        expect(mismatchHtml).toContain('The two passwords do not match.')
        // The language switcher keeps the token that only lives in the posted form.
        expect(mismatchHtml).toContain(
            `next=%2Freset-password%3Ftoken%3D${encodeURIComponent(token)}`
        )
        const reset = await call('/reset-password', {
            origin: LOGIN,
            form: {
                token,
                password: 'new password 123',
                confirm: 'new password 123'
            }
        })
        expect(reset.status).toBe(200)
        const signedIn = await call('/sign-in', {
            origin: LOGIN,
            form: { email, password: 'new password 123' }
        })
        expect(signedIn.status).toBe(200)
        expect(
            signedIn.headers
                .getSetCookie()
                .some((line) => line.startsWith('hawconnect.session_token='))
        ).toBe(true)
    })

    it('unknown client_id shows the error page, never redirects', async () => {
        const response = await call(
            `/api/auth/oauth2/authorize?${new URLSearchParams({
                response_type: 'code',
                client_id: 'not-registered',
                redirect_uri: 'https://evil.example/cb',
                scope: 'openid',
                state: 's',
                code_challenge: CHALLENGE,
                code_challenge_method: 'S256'
            })}`,
            { headers: { Accept: 'text/html' } }
        )
        // The provider only ever sends the browser to the login site's own error page.
        expect(response.status).toBe(302)
        const location = new URL(response.headers.get('location') ?? '')
        expect(location.origin).toBe(LOGIN)
        expect(location.pathname).toBe('/error')
        const page = await call(`${location.pathname}${location.search}`, {
            headers: { 'Accept-Language': 'en' }
        })
        expect(page.status).toBe(400)
        const body = await page.text()
        expect(body).toContain('This app is not registered')
        expect(body).not.toContain('evil.example')
    })

    it('signs in from a real browser form post with login-host cookies', async () => {
        const earlier = address('earlier')
        await confirmedUser(earlier)
        const old = await call('/sign-in', {
            origin: LOGIN,
            form: { email: earlier, password: PASSWORD }
        })
        expect(old.status).toBe(200)
        const email = address('browser')
        await confirmedUser(email)
        const query = await startFlow('browser')
        // An old session cookie and a flow cookie are already on the login host.
        const cookie = cookiesOf(
            old,
            `hawconnect.login_flow=${encodeURIComponent(query)}`
        )
        expect(cookie).toContain('hawconnect.session_token=')
        const signedIn = await call('/sign-in', {
            origin: LOGIN,
            form: { email, password: PASSWORD, oauth_query: query },
            cookie,
            headers: { 'Accept-Language': 'en' }
        })
        if (signedIn.status !== 302)
            expect(await signedIn.text()).not.toContain(
                'Confirm your email address first.'
            )
        expectCode(signedIn, 'browser')
        // Same browser shape, no flow: a plain sign-in page answer, not "confirm your email".
        const direct = await call('/sign-in', {
            origin: LOGIN,
            form: { email, password: PASSWORD },
            cookie,
            headers: { 'Accept-Language': 'en' }
        })
        expect(direct.status).toBe(200)
        expect(await direct.text()).toContain('You are signed in')
    })

    it('keeps prompt=login when restarting an expired request', async () => {
        const email = address('prompt')
        await confirmedUser(email)
        const query = await startFlow('signed-in')
        const signedIn = await call('/sign-in', {
            origin: LOGIN,
            form: { email, password: PASSWORD, oauth_query: query }
        })
        expectCode(signedIn, 'signed-in')
        const cookie = cookiesOf(signedIn)
        // The client asks to re-authenticate although a login session exists.
        const prompted = await startFlow('reauth', cookie, { prompt: 'login' })
        try {
            setSystemTime(new Date(Date.now() + 5 * 60 * 1000))
            const reload = await call(`/sign-in?${prompted}`, { cookie })
            expect(reload.status).toBe(302)
            const restart = new URL(reload.headers.get('location') ?? '')
            expect(restart.searchParams.get('prompt')).toBe('login')
            // The provider asks for the password instead of issuing a code.
            const again = await call(`${restart.pathname}${restart.search}`, {
                cookie,
                headers: { Accept: 'text/html' }
            })
            expect(again.status).toBe(302)
            const location = new URL(again.headers.get('location') ?? '', LOGIN)
            expect(location.origin).toBe(LOGIN)
            expect(location.pathname).toBe('/sign-in')
            expect(location.searchParams.has('code')).toBe(false)
            // Submitting the expired form also restarts with prompt=login kept.
            const submitted = await call('/sign-in', {
                origin: LOGIN,
                form: { email, password: PASSWORD, oauth_query: prompted },
                cookie
            })
            expect(submitted.status).toBe(302)
            expect(
                new URL(
                    submitted.headers.get('location') ?? ''
                ).searchParams.get('prompt')
            ).toBe('login')
        } finally {
            setSystemTime()
        }
    })

    // A browser: one cookie jar per host, redirects followed by hand while they
    // stay on our two hosts (login site and API), fetch metadata like Chromium.
    const OUR_HOSTS = new Set([LOGIN_HOST, API_HOST])
    type Visit = { url: URL; response: Response; body: string }
    const browser = (language = 'en') => {
        const ip = `192.0.2.${randomByte()}`
        const jars = new Map<string, string>()
        const send = async (
            url: URL,
            init: {
                form?: Record<string, string>
                json?: unknown
                from?: URL
                origin?: string
            } = {}
        ) => {
            const headers: Record<string, string> = {
                Host: url.host,
                'X-Forwarded-For': ip,
                'Accept-Language': language
            }
            if (init.json === undefined)
                Object.assign(headers, {
                    Accept: 'text/html,application/xhtml+xml',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Site': !init.from
                        ? 'none'
                        : init.from.origin === url.origin
                          ? 'same-origin'
                          : 'cross-site'
                })
            else headers['Content-Type'] = 'application/json'
            const cookie = jars.get(url.host)
            if (cookie) headers.Cookie = cookie
            if (init.form) {
                headers['Content-Type'] = 'application/x-www-form-urlencoded'
                headers.Origin = init.from?.origin ?? 'null'
            }
            if (init.origin) headers.Origin = init.origin
            const response = await fetch(
                `${base}${url.pathname}${url.search}`,
                {
                    method:
                        init.form || init.json !== undefined ? 'POST' : 'GET',
                    redirect: 'manual',
                    headers,
                    body: init.form
                        ? new URLSearchParams(init.form).toString()
                        : init.json !== undefined
                          ? JSON.stringify(init.json)
                          : undefined
                }
            )
            jars.set(url.host, cookiesOf(response, jars.get(url.host)))
            return response
        }
        /** Follows 30x while on our hosts; `check` sees every Location. */
        const follow = async (
            url: URL,
            response: Response,
            check?: (next: URL) => void
        ): Promise<Visit> => {
            let current = url
            let answer = response
            while (answer.status >= 300 && answer.status < 400) {
                const next = new URL(
                    answer.headers.get('location') ?? '',
                    current
                )
                check?.(next)
                // Another site (the web app): the browser leaves us here.
                if (!OUR_HOSTS.has(next.host))
                    return { url: next, response: answer, body: '' }
                answer = await send(next, { from: current })
                current = next
            }
            return { url: current, response: answer, body: await answer.text() }
        }
        const open = async (url: string) => {
            const target = new URL(url)
            return follow(target, await send(target))
        }
        /**
         * Submits the page's post form as a browser does. Browsers apply the
         * page's CSP form-action to the form action and to every redirect that
         * follows the post, so each of them must be allowed by that page's policy.
         */
        const browserSubmit = async (
            page: Visit,
            fields: Record<string, string> = {}
        ) => {
            const csp =
                page.response.headers.get('content-security-policy') ?? ''
            const sources = (
                csp
                    .split(';')
                    .map((part) => part.trim())
                    .find((part) => part.startsWith('form-action ')) ??
                'form-action'
            )
                .split(/\s+/)
                .slice(1)
            const allowed = (target: URL) =>
                sources.some((source) =>
                    source === "'self'"
                        ? target.origin === page.url.origin
                        : /^[a-z][a-z0-9+.-]*:$/.test(source)
                          ? target.protocol === source
                          : target.origin === source
                )
            const expectAllowed = (target: URL) =>
                expect({
                    target: target.toString(),
                    allowedByFormAction: allowed(target)
                }).toEqual({
                    target: target.toString(),
                    allowedByFormAction: true
                })
            const form = page.body.match(
                /<form method="post"[^>]*\baction="([^"]*)"[^>]*>([\s\S]*?)<\/form>/
            )
            if (!form) throw new Error(`no form on ${page.url}`)
            const action = new URL(decodeEntities(form[1]), page.url)
            expectAllowed(action)
            const values: Record<string, string> = {}
            for (const input of form[2].matchAll(
                /<(?:input type="hidden"|button type="submit")[^>]*\bname="([^"]+)" value="([^"]*)"/g
            ))
                values[input[1]] = decodeEntities(input[2])
            Object.assign(values, fields)
            const response = await send(action, {
                form: values,
                from: page.url
            })
            return follow(action, response, expectAllowed)
        }
        return {
            open,
            browserSubmit,
            send,
            cookie: (host: string) => jars.get(host) ?? '',
            setCookie: (host: string, cookie: string) => jars.set(host, cookie)
        }
    }
    type Browser = ReturnType<typeof browser>
    /** Signs in at the login site directly (form post), so the browser holds a login session. */
    const signedInAtLogin = async (b: Browser) => {
        const email = address('logout')
        await confirmedUser(email)
        const query = await startFlow(`logout-${randomByte()}`)
        const signedIn = await call('/sign-in', {
            origin: LOGIN,
            form: { email, password: PASSWORD, oauth_query: query }
        })
        expect(signedIn.status).toBe(302)
        b.setCookie(LOGIN_HOST, cookiesOf(signedIn))
        return email
    }
    /** The web app's sign-in: API start, typed password on the login site, back on the web app. */
    const webSignIn = async (b: Browser, returnPath = '/') => {
        const email = address('web')
        await confirmedUser(email)
        const page = await b.open(
            `${API}/api/accounts/oidc/start?return=${encodeURIComponent(returnPath)}`
        )
        expect(page.response.status).toBe(200)
        expect(`${page.url.origin}${page.url.pathname}`).toBe(
            `${LOGIN}/sign-in`
        )
        const done = await b.browserSubmit(page, { email, password: PASSWORD })
        return { email, done }
    }
    const endSession = (extra: Record<string, string> = {}) =>
        `${LOGIN}/api/auth/oauth2/end-session?${new URLSearchParams({
            client_id: 'hawconnect-app',
            post_logout_redirect_uri: `${WEB}/`,
            ...extra
        })}`
    /** Whether authorize asks for the password again (no login session left). */
    const asksForSignIn = async (b: Browser) => {
        const next = await b.open(`${LOGIN}${authorize('check')}`)
        return `${next.url.origin}${next.url.pathname}` === `${LOGIN}/sign-in`
    }
    const userIdOf = async (email: string) =>
        (await pool.query('SELECT id FROM haw_user WHERE email = $1', [email]))
            .rows[0].id as string

    it('a typed-password web sign-in passes form-action on every hop to the web app', async () => {
        const b = browser()
        const { done } = await webSignIn(b, '/marketplace')
        expect(done.url.toString()).toBe(`${WEB}/marketplace`)
        expect(b.cookie(API_HOST)).toContain('hawconnect.session_token=')
    })

    it('signing out on the confirm page passes form-action on every hop to the web app', async () => {
        const b = browser()
        await signedInAtLogin(b)
        expect(await asksForSignIn(b)).toBe(false)
        // No ticket (or one that does not fit): the person confirms on our page.
        const page = await b.open(endSession())
        expect(page.response.status).toBe(200)
        const done = await b.browserSubmit(page)
        expect(done.url.toString()).toBe(`${WEB}/`)
        expect(await asksForSignIn(b)).toBe(true)
    })

    it('every HTML answer on the login host has our policy, layout and language', async () => {
        const b = browser('de')
        await signedInAtLogin(b)
        const visits: Visit[] = []
        for (const path of PAGES) visits.push(await b.open(`${LOGIN}${path}`))
        visits.push(
            await b.open(endSession()),
            await b.open(`${LOGIN}/sign-out`),
            await b.open(`${LOGIN}/nowhere`),
            await b.open(
                `${LOGIN}/api/auth/oauth2/authorize?${new URLSearchParams({
                    response_type: 'code',
                    client_id: 'not-registered',
                    redirect_uri: 'https://evil.example/cb',
                    scope: 'openid',
                    state: 's',
                    code_challenge: CHALLENGE,
                    code_challenge_method: 'S256'
                })}`
            )
        )
        for (const visit of visits) {
            expect(visit.url.origin).toBe(LOGIN)
            expect(visit.response.headers.get('content-type')).toContain(
                'text/html'
            )
            expect({
                url: visit.url.pathname,
                csp: visit.response.headers.get('content-security-policy')
            }).toEqual({ url: visit.url.pathname, csp: CSP })
            expect(visit.body).toContain('<html lang="de">')
            expect(visit.body).toContain('<div class="brand">')
            // The terms notice belongs only where someone signs in or signs up.
            const agrees = ['/sign-in', '/create-account'].includes(
                visit.url.pathname
            )
            expect({
                url: visit.url.pathname,
                notice: visit.body.includes(
                    'Wenn du fortfährst, stimmst du unseren'
                )
            }).toEqual({ url: visit.url.pathname, notice: agrees })
        }
        // The end-session address shows our own German confirmation page.
        const confirm = visits[PAGES.length]
        expect(confirm.url.pathname).toBe('/sign-out')
        expect(confirm.body).toContain('<h1>Abmelden</h1>')
        expect(confirm.body).toContain('action="/sign-out"')
    })

    it('signs out with one click when the API ticket names the signed-in person', async () => {
        const b = browser()
        const { email, done } = await webSignIn(b)
        expect(done.url.toString()).toBe(`${WEB}/`)
        const out = await b.send(new URL(`${API}/api/accounts/sign-out`), {
            json: {},
            origin: WEB
        })
        expect(out.status).toBe(200)
        const { endSessionUrl } = (await out.json()) as {
            endSessionUrl: string
        }
        expect(new URL(endSessionUrl).searchParams.get('ticket')).toBeTruthy()
        // One navigation, no page: the login session ends and the browser is back.
        const landed = await b.open(endSessionUrl)
        expect(landed.url.toString()).toBe(`${WEB}/`)
        expect(landed.body).toBe('')
        expect(await asksForSignIn(b)).toBe(true)
        expect(email).toContain('@')
    })

    it('asks to confirm for a ticket of another person or an expired ticket', async () => {
        const b = browser()
        const email = await signedInAtLogin(b)
        const other = await b.open(
            endSession({ ticket: createLogoutTicket(SECRET, 'someone-else') })
        )
        expect(other.response.status).toBe(200)
        expect(other.url.pathname).toBe('/sign-out')
        expect(other.body).toContain('action="/sign-out"')
        expect(await asksForSignIn(b)).toBe(false)
        const ticket = createLogoutTicket(SECRET, await userIdOf(email))
        try {
            setSystemTime(new Date(Date.now() + 61 * 1000))
            const expired = await b.open(endSession({ ticket }))
            expect(expired.response.status).toBe(200)
            expect(expired.body).toContain('action="/sign-out"')
            expect(await asksForSignIn(b)).toBe(false)
        } finally {
            setSystemTime()
        }
        // A forged signature is no ticket either.
        const forged = await b.open(
            endSession({ ticket: `${ticket.slice(0, -3)}AAA` })
        )
        expect(forged.body).toContain('action="/sign-out"')
        expect(await asksForSignIn(b)).toBe(false)
    })

    it('goes to the signed-out page for an unregistered return address', async () => {
        const b = browser()
        await signedInAtLogin(b)
        const page = await b.open(
            endSession({ post_logout_redirect_uri: 'https://evil.example/' })
        )
        expect(page.response.status).toBe(200)
        expect(page.body).not.toContain('evil.example')
        const done = await b.browserSubmit(page)
        expect(done.url.toString()).toBe(`${LOGIN}/signed-out`)
        expect(done.response.status).toBe(200)
        expect(await asksForSignIn(b)).toBe(true)
        // Unknown client: the same.
        const none = browser()
        const unknown = await none.open(
            endSession({ client_id: 'not-registered' })
        )
        expect(unknown.url.toString()).toBe(`${LOGIN}/signed-out`)
    })

    it('without a login session goes straight to the return address', async () => {
        const b = browser()
        const landed = await b.open(endSession())
        expect(landed.url.toString()).toBe(`${WEB}/`)
        expect(landed.body).toBe('')
    })

    it('limits provider requests per address', async () => {
        const ip = `203.0.113.${randomByte()}`
        const statuses: number[] = []
        for (let index = 0; index < 61; index++)
            statuses.push((await call('/api/auth/jwks', { ip })).status)
        expect(statuses.slice(0, 60)).not.toContain(429)
        expect(statuses[60]).toBe(429)
    }, 30_000)

    it('discovery advertises only reachable endpoints and supported client authentication', async () => {
        const response = await call('/.well-known/openid-configuration')
        expect(response.status).toBe(200)
        const discovery = (await response.json()) as Record<string, unknown>
        expect(discovery.issuer).toBe(LOGIN)
        expect(discovery.introspection_endpoint).toBeUndefined()
        expect(discovery.revocation_endpoint).toBeUndefined()
        expect(
            Object.keys(discovery).filter((key) =>
                /introspection|revocation/.test(key)
            )
        ).toEqual([])
        expect(discovery.token_endpoint_auth_methods_supported).toEqual([
            'client_secret_post',
            'none'
        ])
        // Every advertised address answers on the login host.
        for (const [key, value] of Object.entries(discovery))
            if (key.endsWith('_endpoint') || key === 'jwks_uri') {
                const url = new URL(String(value))
                expect(url.origin).toBe(LOGIN)
                const answer = await call(`${url.pathname}${url.search}`, {
                    method: key === 'token_endpoint' ? 'POST' : 'GET',
                    form: key === 'token_endpoint' ? {} : undefined
                })
                expect({ key, status: answer.status }).not.toEqual({
                    key,
                    status: 404
                })
            }
    })
})

// No database: the unavailable login host serves the same static routes.
describe('login site static assets (no database)', () => {
    const UNAVAILABLE_CSP =
        "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'"
    const app = express()
    app.use(loginHostGate(LOGIN, unavailableLoginHost(LOGIN)))
    let server: Server
    beforeAll(async () => {
        server = await new Promise<Server>((resolve) => {
            const started = app.listen(0, () => resolve(started))
        })
    })
    afterAll(() => {
        server.close()
    })
    // http.get keeps dot segments and encoded slashes as written (fetch would normalise them).
    const get = (path: string, extra: Record<string, string> = {}) =>
        new Promise<{
            status: number
            headers: Record<string, string | string[] | undefined>
            body: Buffer
        }>((resolve, reject) => {
            const port = (server.address() as AddressInfo).port
            httpGet(
                {
                    host: '127.0.0.1',
                    port,
                    path,
                    headers: { host: LOGIN_HOST, ...extra }
                },
                (res) => {
                    const chunks: Buffer[] = []
                    res.on('data', (chunk: Buffer) => chunks.push(chunk))
                    res.on('end', () =>
                        resolve({
                            status: res.statusCode ?? 0,
                            headers: res.headers,
                            body: Buffer.concat(chunks)
                        })
                    )
                }
            ).on('error', reject)
        })

    it('styles the site with the purple tokens, light and dark', async () => {
        const css = (await get('/login.css')).body.toString('utf8')
        expect(css.toLowerCase()).toContain('--hc-primary: #40296c')
        expect(css.toLowerCase()).toContain('--hc-dark-primary: #ac97d3')
        expect(css.toLowerCase()).not.toContain('#007aff')
        expect(css).not.toContain('rgb(255, 59, 48)')
        expect(css).not.toContain('rgb(255, 69, 58)')
        expect(css).toContain('@media (prefers-reduced-motion: reduce)')
        const wrap = css.slice(
            0,
            css.indexOf('}', css.indexOf('overflow-wrap'))
        )
        for (const selector of [
            'h1',
            'p',
            'label',
            '.message',
            '.hint',
            'footer',
            'button'
        ])
            expect(wrap).toContain(selector)
        expect(wrap).toContain('overflow-wrap: anywhere')
        expect(css.toLowerCase()).not.toContain('#0e83fd')
        expect(css).toMatch(/font-family:\s*['"]Outfit['"]/)
        for (const weight of [400, 500, 600, 700])
            expect(css).toMatch(
                new RegExp(
                    `src: url\\(['"]/fonts/outfit-latin-${weight}-normal.woff2['"]\\)`
                )
            )
        expect(css.match(/@font-face/g)?.length).toBe(4)
    })

    it('serves the allow-listed fonts and licence', async () => {
        for (const weight of [400, 500, 600, 700]) {
            const font = await get(`/fonts/outfit-latin-${weight}-normal.woff2`)
            expect(font.status).toBe(200)
            expect(font.headers['content-type']).toBe('font/woff2')
            expect(font.headers['cache-control']).toBe(
                'public, max-age=31536000, immutable'
            )
            expect(font.body.length).toBeGreaterThan(1000)
        }
        const licence = await get('/fonts/OFL.txt')
        expect(licence.status).toBe(200)
        expect(String(licence.headers['content-type'])).toContain('text/plain')
        expect(licence.body.toString('utf8')).toContain('Open Font License')
    })

    it('answers 404 for anything else under /fonts', async () => {
        for (const path of [
            '/fonts/nope.woff2',
            '/fonts/..%2Flogin.css',
            '/fonts/%2e%2e/login.css',
            '/fonts/../login.css',
            '/fonts/outfit-latin-400-normal.woff2/x',
            '/fonts/'
        ]) {
            const response = await get(path)
            expect({ path, status: response.status }).not.toEqual({
                path,
                status: 200
            })
            expect(response.body.toString('utf8')).not.toContain('--hc-')
        }
        expect((await get('/fonts/nope.woff2')).status).toBe(404)
        expect((await get('/fonts/..%2Flogin.css')).status).toBe(404)
        expect((await get('/fonts/%2e%2e/login.css')).status).toBe(404)
    })

    it('keeps the content security policy', async () => {
        for (const path of [
            '/login.css',
            '/fonts/outfit-latin-400-normal.woff2'
        ])
            expect((await get(path)).headers['content-security-policy']).toBe(
                UNAVAILABLE_CSP
            )
    })

    describe('language switcher', () => {
        it('resolves the language: cookie first, then Accept-Language', () => {
            expect(resolveLanguage('hawconnect-login-lang=en', 'de-DE')).toBe(
                'en'
            )
            expect(
                resolveLanguage('a=b; hawconnect-login-lang=de', 'en-US')
            ).toBe('de')
            expect(resolveLanguage(undefined, 'en-US')).toBe('en')
            expect(resolveLanguage('a=b', 'de')).toBe('de')
            expect(resolveLanguage('hawconnect-login-lang=fr', 'en')).toBe('en')
            expect(resolveLanguage('hawconnect-login-lang=', 'en')).toBe('en')
        })

        it('defaults to English without a supported language', () => {
            expect(languageOf(undefined)).toBe('en')
            expect(languageOf('')).toBe('en')
            expect(languageOf('fr-FR,fr;q=0.9')).toBe('en')
            expect(languageOf('fr, de;q=0.5')).toBe('de')
            expect(languageOf('de-DE,en;q=0.5')).toBe('de')
            expect(resolveLanguage(undefined, undefined)).toBe('en')
            expect(resolveLanguage('hawconnect-login-lang=x', 'ja')).toBe('en')
        })

        it('sets the cookie and redirects back, keeping the OAuth query', async () => {
            const next = '/sign-in?oauth_query=a%3D1%26b%3D2'
            const answer = await get(
                `/language?${new URLSearchParams({ to: 'en', next })}`
            )
            expect(answer.status).toBe(303)
            expect(answer.headers.location).toBe(next)
            const cookie = String(answer.headers['set-cookie'])
            expect(cookie).toContain('hawconnect-login-lang=en')
            expect(cookie).toContain('Path=/')
            expect(cookie).toContain('Max-Age=31536000')
            expect(cookie).toContain('SameSite=Lax')
            expect(cookie).toContain('HttpOnly')
            expect(cookie).not.toContain('Secure')
        })

        it('only redirects to paths on the site', async () => {
            for (const next of [
                '//evil.example',
                'https://evil.example',
                '/\\evil.example',
                '/\r\nSet-Cookie: x=y',
                '/ok\nX: y',
                '/%2F%2Fevil.example',
                '/%5Cevil.example',
                '/ok%0d%0aSet-Cookie:x=y',
                '/a\\b',
                'javascript:alert(1)',
                'evil',
                '',
                '/ok\r\nX: y',
                `/${'a'.repeat(8192)}`,
                '/language?to=de'
            ]) {
                const answer = await get(
                    `/language?${new URLSearchParams({ to: 'de', next })}`
                )
                expect({ next, status: answer.status }).toEqual({
                    next,
                    status: 303
                })
                expect(answer.headers.location).toBe('/sign-in')
            }
            const missing = await get('/language?to=de')
            expect(missing.headers.location).toBe('/sign-in')
        })

        it('keeps an encoded query but not encoded slashes in the path', () => {
            const logout =
                '/sign-out?client_id=hawconnect-app&post_logout_redirect_uri=https%3A%2F%2Fapp.hawconnect.de%2Fsigned-out&state=abc'
            expect(safeNext(logout)).toBe(logout)
            expect(safeNext('/%2F%2Fevil')).toBe('/sign-in')
            expect(safeNext('/%5Cevil')).toBe('/sign-in')
            expect(safeNext('/ok?x=a\nb')).toBe('/sign-in')
            expect(
                safeNext(`/sign-in?q=${'a'.repeat(5000)}`).length
            ).toBeGreaterThan(5000)
            expect(safeNext(`/${'a'.repeat(8192)}`)).toBe('/sign-in')
        })

        it('answers 400 for an unknown language', async () => {
            for (const query of ['to=fr', '', 'to=en&to=de', 'to[]=en'])
                expect((await get(`/language?${query}`)).status).toBe(400)
        })

        const context = (
            lang: 'de' | 'en',
            extra: Partial<PageContext> = {}
        ): PageContext => ({
            lang,
            copy: copies[lang],
            service: 'HAWConnect',
            flow: '',
            stylesheet: '/login.css',
            ...extra
        })

        it('shows the language menu below the card, keeping path and query', () => {
            const page = confirmPage(
                context('de', { current: '/confirm?token=abc123' }),
                'abc123abc123abc123'
            )
            expect(page).toContain(
                '<details class="menu" name="login-controls"><summary aria-label="Sprache: DE">'
            )
            expect(page).toContain('aria-hidden="true"')
            expect(page).toContain('<span>DE</span></summary><ul>')
            expect(page).toContain(
                '<li><span lang="de" aria-current="true">Deutsch</span></li>'
            )
            expect(page).toContain(
                '<li><a lang="en" href="/language?to=en&amp;next=%2Fconfirm%3Ftoken%3Dabc123">English</a></li>'
            )
            expect(page.indexOf('</main>')).toBeLessThan(
                page.indexOf('class="controls"')
            )
            expect(page).not.toContain('<script')
        })

        it('shows a three-option theme menu with the current choice', () => {
            // No cookie: the device decides, so "system" is current and data-theme is absent.
            const system = signInPage(context('en', { current: '/sign-in' }))
            expect(system).not.toContain('data-theme')
            expect(system).toContain(
                '<details class="menu theme" name="login-controls"><summary aria-label="Theme: System">'
            )
            expect(system).toContain('aria-current="true">')
            expect(system).toMatch(
                /<span aria-current="true">.*?System<\/span>/
            )
            expect(system).toContain(
                'href="/theme?to=light&amp;next=%2Fsign-in"'
            )
            expect(system).toContain(
                'href="/theme?to=dark&amp;next=%2Fsign-in"'
            )
            expect(system).not.toContain('to-dark')
            const dark = signInPage(
                context('de', { theme: 'dark', current: '/sign-in' })
            )
            expect(dark).toContain('<html lang="de" data-theme="dark">')
            expect(dark).toContain('<summary aria-label="Design: Dunkel">')
            expect(dark).toMatch(/<span aria-current="true">.*?Dunkel<\/span>/)
            expect(dark).toContain('>Hell</a>')
            expect(dark).toContain('>System</a>')
            const light = signInPage(
                context('en', { theme: 'light', current: '/sign-in' })
            )
            expect(light).toContain('<html lang="en" data-theme="light">')
            expect(light).toContain('<summary aria-label="Theme: Light">')
            expect(light).toContain(
                'href="/theme?to=system&amp;next=%2Fsign-in"'
            )
        })

        it('keeps only one controls menu open at a time', () => {
            const page = signInPage(context('en'))
            expect(
                page.match(/<details [^>]*name="login-controls"/g)?.length
            ).toBe(2)
            expect(page.match(/<details/g)?.length).toBe(2)
        })

        it('shows the controls on the form pages only', () => {
            const ctx = context('en')
            for (const page of [
                signInPage(ctx),
                createAccountPage(ctx),
                forgotPasswordPage(ctx),
                resetPasswordPage(ctx, 'abc123abc123abc123'),
                confirmPage(ctx, 'abc123abc123abc123'),
                checkEmailPage(ctx, { email: 'a@b.de' })
            ])
                expect(page).toContain('<div class="controls">')
            for (const page of [
                noticePage(ctx, 'Title', 'Text'),
                noticePage(ctx, 'Title', 'Text', { backToSignIn: true }),
                signOutPage(ctx, {
                    clientId: '',
                    postLogoutRedirectUri: '',
                    state: ''
                })
            ])
                expect(page).not.toContain('class="controls"')
        })

        it('has no controls on the unavailable host', async () => {
            const page = (await get('/sign-in')).body.toString('utf8')
            expect(page).toContain('<h1>')
            expect(page).not.toContain('class="controls"')
            expect(page).not.toContain('<details')
        })

        it('follows the cookie over Accept-Language, English by default', () => {
            expect(resolveLanguage('hawconnect-login-lang=en', 'de')).toBe('en')
            expect(resolveLanguage(undefined, 'fr')).toBe('en')
            expect(resolveLanguage(undefined, undefined)).toBe('en')
        })

        it('sets, clears and rejects the theme like the language', async () => {
            const answer = await get(
                `/theme?${new URLSearchParams({ to: 'dark', next: '/forgot-password' })}`
            )
            expect(answer.status).toBe(303)
            expect(answer.headers.location).toBe('/forgot-password')
            const cookie = String(answer.headers['set-cookie'])
            for (const part of [
                'hawconnect-login-theme=dark',
                'Path=/',
                'Max-Age=31536000',
                'SameSite=Lax',
                'HttpOnly'
            ])
                expect(cookie).toContain(part)
            expect(cookie).not.toContain('Secure')
            // "system" removes the cookie, with the same attributes.
            const cleared = await get(
                `/theme?${new URLSearchParams({ to: 'system', next: '/sign-in' })}`
            )
            expect(cleared.status).toBe(303)
            expect(cleared.headers.location).toBe('/sign-in')
            const gone = String(cleared.headers['set-cookie'])
            expect(gone).toContain('hawconnect-login-theme=;')
            expect(gone).toContain('Max-Age=0')
            expect(gone).toContain('Path=/')
            expect(gone).toContain('SameSite=Lax')
            expect(gone).toContain('HttpOnly')
            for (const query of ['to=auto', 'to=', '', 'to=dark&to=light'])
                expect((await get(`/theme?${query}`)).status).toBe(400)
            for (const next of [
                '//evil.example',
                'https://evil.example',
                '/\\evil.example',
                '/%2F%2Fevil.example',
                '/%5Cevil.example',
                '/ok\r\nSet-Cookie: x=y',
                '/theme?to=dark'
            ]) {
                const rejected = await get(
                    `/theme?${new URLSearchParams({ to: 'light', next })}`
                )
                expect(rejected.status).toBe(303)
                expect(rejected.headers.location).toBe('/sign-in')
            }
            expect(
                (await get('/theme?to=dark')).headers['content-security-policy']
            ).toBe(UNAVAILABLE_CSP)
        })

        it('reads the theme cookie', () => {
            expect(themeOf('hawconnect-login-theme=dark')).toBe('dark')
            expect(themeOf('a=b; hawconnect-login-theme=light')).toBe('light')
            expect(themeOf('hawconnect-login-theme=system')).toBeUndefined()
            expect(themeOf('hawconnect-login-theme=blue')).toBeUndefined()
            expect(themeOf(undefined)).toBeUndefined()
        })

        it('styles the dark tokens for the device and for an explicit choice', async () => {
            const css = (await get('/login.css')).body.toString('utf8')
            expect(css).toContain('@media (prefers-color-scheme: dark)')
            expect(css).toContain(':root:not([data-theme])')
            expect(css).toContain(':root[data-theme="dark"]')
            expect(css).toContain(':root[data-theme="light"]')
            expect(css).not.toContain('a.theme')
            expect(css.toLowerCase()).toContain('--hc-dark-primary: #ac97d3')
        })

        it('does not change the content security policy', async () => {
            expect(
                (await get('/language?to=en')).headers[
                    'content-security-policy'
                ]
            ).toBe(UNAVAILABLE_CSP)
        })
    })
})
