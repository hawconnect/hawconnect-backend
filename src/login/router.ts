import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node'
import express, {
    type ErrorRequestHandler,
    type Request,
    type RequestHandler,
    type Response
} from 'express'
import {
    type AccountActions,
    MAX_PASSWORD,
    MIN_PASSWORD
} from '@/lib/account-actions'
import type { AccountAuthService } from '@/lib/account-auth'
import { readLogoutTicket } from '@/lib/logout-ticket'
import type { OidcClientConfig } from '@/lib/oidc-clients'
import {
    copies,
    fill,
    LANGUAGE_COOKIE,
    resolveLanguage,
    THEME_COOKIE,
    themeOf
} from './copy'
import { createFlows, DEFAULT_SERVICE, type Flow } from './flow'
import {
    checkEmailPage,
    confirmPage,
    createAccountPage,
    forgotPasswordPage,
    MAX_NAME,
    type Message,
    noticePage,
    type PageContext,
    resetPasswordPage,
    signInPage,
    signOutPage
} from './pages'
import {
    cookieOf,
    formTargetsOf,
    isLoginHost,
    securityHeaders
} from './security'

export interface LoginDeps {
    auth: AccountAuthService['auth']
    actions: AccountActions
    limited: AccountAuthService['limited']
    clients: OidcClientConfig[]
    loginOrigin: string
}

/**
 * The only provider routes forwarded to better-auth, and only on the login host.
 * End-session is not among them: `/api/auth/oauth2/end-session` is answered by
 * our own `/sign-out` (see createLoginHost), so the add-on's own logout pages
 * (and their `form-action 'self'` policy) are never served.
 */
export const PROVIDER_PATHS = new Set([
    '/.well-known/openid-configuration',
    '/api/auth/oauth2/authorize',
    '/api/auth/oauth2/token',
    '/api/auth/oauth2/userinfo',
    '/api/auth/jwks'
])
const END_SESSION_PATH = '/api/auth/oauth2/end-session'
const DISCOVERY_PATH = '/.well-known/openid-configuration'
/** Provider requests per address and minute (H4). */
const PROVIDER_LIMIT = 60
const FORM_PATHS = [
    '/sign-out',
    '/sign-in',
    '/create-account',
    '/check-email',
    '/verify-code',
    '/confirm',
    '/forgot-password',
    '/reset-password'
]
/** Provider error codes that mean the requesting app is not (or no longer) registered. */
const UNKNOWN_CLIENT_ERRORS = new Set([
    'invalid_client',
    'client_disabled',
    'invalid_redirect',
    'unauthorized_client'
])

const css = readFileSync(new URL('./login.css', import.meta.url), 'utf8')
/** The self-hosted fonts: exact file names, read once; the request never reaches the filesystem. */
const FONT_FILES: Record<string, string> = {
    'outfit-latin-400-normal.woff2': 'font/woff2',
    'outfit-latin-500-normal.woff2': 'font/woff2',
    'outfit-latin-600-normal.woff2': 'font/woff2',
    'outfit-latin-700-normal.woff2': 'font/woff2',
    'OFL.txt': 'text/plain; charset=utf-8'
}
const fonts = new Map(
    Object.entries(FONT_FILES).map(([name, type]) => [
        name,
        {
            type,
            body: readFileSync(new URL(`./fonts/${name}`, import.meta.url))
        }
    ])
)
/** `GET /fonts/<name>`: an allow-listed file, otherwise 404. */
const fontRoute: RequestHandler = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    const font = fonts.get(req.path.slice(1))
    if (!font) {
        res.status(404).end()
        return
    }
    res.set('Cache-Control', 'public, max-age=31536000, immutable')
        .type(font.type)
        .send(font.body)
}
const stylesheet = `/login.css?v=${createHash('sha256').update(css).digest('hex').slice(0, 12)}`

const languageOf = (req: Request) =>
    resolveLanguage(req.headers.cookie, req.headers['accept-language'])

/** Longest `next` the language route follows. */
const MAX_NEXT = 8192
/** `next` only if it is a path on this site; anything else (other hosts, schemes, odd characters) is `/sign-in`. */
export function safeNext(value: string): string {
    if (
        value.length > MAX_NEXT ||
        !value.startsWith('/') ||
        value.startsWith('//') ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
        /[\\\x00-\x1f\x7f]/.test(value) ||
        // Encoded slashes and line breaks are only a risk in the path; a query may carry them (e.g. a return address).
        /%(2f|5c|0d|0a|00)/i.test(value.split('?')[0])
    )
        return '/sign-in'
    try {
        const url = new URL(value, 'http://login.invalid')
        if (
            url.origin !== 'http://login.invalid' ||
            url.pathname === '/language' ||
            url.pathname === '/theme'
        )
            return '/sign-in'
    } catch {
        return '/sign-in'
    }
    return value
}

/** `GET /<route>?to=<value>&next=/path`: remembers the choice in a cookie and goes back. */
function choiceRoute(
    cookie: string,
    allowed: string[],
    secure: boolean,
    /** The value that removes the cookie instead of setting it. */
    clears?: string
): RequestHandler {
    return (req, res) => {
        const to = req.query.to
        if (typeof to !== 'string' || !allowed.includes(to)) {
            res.status(400).type('text').send('Bad request')
            return
        }
        const next = req.query.next
        const attributes = `Path=/; SameSite=Lax; HttpOnly${secure ? '; Secure' : ''}`
        res.append(
            'Set-Cookie',
            to === clears
                ? `${cookie}=; Max-Age=0; ${attributes}`
                : `${cookie}=${to}; Max-Age=31536000; ${attributes}`
        )
        res.redirect(303, safeNext(typeof next === 'string' ? next : ''))
    }
}
const languageRoute = (secure: boolean) =>
    choiceRoute(LANGUAGE_COOKIE, ['de', 'en'], secure)
const themeRoute = (secure: boolean) =>
    choiceRoute(THEME_COOKIE, ['light', 'dark', 'system'], secure, 'system')

/**
 * What the switcher returns to: this page's path with the verified flow and the
 * mail-link token only. Other query values (from the address bar) are not echoed.
 */
const currentOf = (req: Request, flow = '') => {
    const params = new URLSearchParams()
    if (flow) params.set('oauth_query', flow)
    // The mail-link token is in the address on GET and in a hidden field on a posted form.
    const token =
        req.method === 'POST'
            ? (req.body as Record<string, unknown> | undefined)?.token
            : req.query.token
    if (typeof token === 'string' && token.length <= 512) {
        if (req.path === '/confirm' || req.path === '/reset-password')
            params.set('token', token)
    }
    // A failed code entry is shown on the check-email page.
    const page = req.path === '/verify-code' ? '/check-email' : req.path
    const path = FORM_PATHS.includes(page) ? page : '/sign-in'
    return params.size ? `${path}?${params}` : path
}

const field = (body: unknown, name: string) => {
    const value = (body as Record<string, unknown> | undefined)?.[name]
    return typeof value === 'string' ? value : ''
}
const queryField = (req: Request, name: string) => {
    const value = req.query[name]
    return typeof value === 'string' ? value : ''
}

/** The login pages (`/sign-in`, `/create-account`, …) for the login host. */
export function createLoginRouter(deps: LoginDeps): express.Router {
    const { actions } = deps
    const loginOrigin = new URL(deps.loginOrigin).origin
    const secure = loginOrigin.startsWith('https:')
    const flows = createFlows({
        clients: deps.clients,
        loginOrigin,
        secret: async () => (await deps.auth.$context).secret
    })
    // Bridges the flow across the mail hop (confirm and reset links carry only the token).
    const flowCookie = secure
        ? '__Host-hawconnect.login_flow'
        : 'hawconnect.login_flow'
    const cookieTail = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
    const keepFlow = (res: Response, flow: Flow) => {
        if (flow.kind === 'valid' || flow.kind === 'expired')
            res.append(
                'Set-Cookie',
                `${flowCookie}=${encodeURIComponent(flow.query)}; Max-Age=3600; ${cookieTail}`
            )
    }
    // Remembers the address between sign-up and typing the code (not in the URL).
    const emailCookie = secure
        ? '__Host-hawconnect.login_email'
        : 'hawconnect.login_email'
    const keepEmail = (res: Response, email: string) =>
        res.append(
            'Set-Cookie',
            `${emailCookie}=${encodeURIComponent(email)}; Max-Age=3600; ${cookieTail}`
        )
    const dropEmail = (res: Response) =>
        res.append('Set-Cookie', `${emailCookie}=; Max-Age=0; ${cookieTail}`)
    const pendingEmail = (req: Request) => {
        try {
            const value = decodeURIComponent(
                cookieOf(req.headers, emailCookie) ?? ''
            )
            return value.length <= 254 ? value : ''
        } catch {
            return ''
        }
    }
    const dropFlow = (res: Response) =>
        res.append('Set-Cookie', `${flowCookie}=; Max-Age=0; ${cookieTail}`)

    const contextOf = (req: Request, flow: Flow = { kind: 'none' }) => {
        const lang = languageOf(req)
        const carried = flow.kind === 'valid' || flow.kind === 'expired'
        return {
            lang,
            copy: copies[lang],
            service: carried ? flow.service : DEFAULT_SERVICE,
            flow: carried ? flow.query : '',
            stylesheet,
            theme: themeOf(req.headers.cookie),
            current: currentOf(req, carried ? flow.query : '')
        } satisfies PageContext
    }
    const send = (res: Response, status: number, page: string) => {
        res.status(status).type('html').send(page)
    }
    const fail = (req: Request, res: Response, status: number, text: string) =>
        send(
            res,
            status,
            noticePage(contextOf(req), contextOf(req).copy.errorTitle, text, {
                backToSignIn: status !== 403
            })
        )
    /** A flow that is broken beyond restarting is shown as an error, never followed. */
    const flowFailed = (req: Request, res: Response) =>
        fail(req, res, 400, contextOf(req).copy.flowFailed)
    /** On confirm and reset, a stale or broken flow is dropped: the link still works. */
    const lenient = (flow: Flow): Flow =>
        flow.kind === 'invalid' ? { kind: 'none' } : flow
    const passwordProblem = (
        ctx: PageContext,
        password: string,
        confirm: string
    ): Message => {
        if (password.length < MIN_PASSWORD)
            return {
                kind: 'error',
                text: fill(ctx.copy.passwordTooShort, { min: MIN_PASSWORD })
            }
        if (password.length > MAX_PASSWORD)
            return { kind: 'error', text: ctx.copy.passwordTooLong }
        if (password !== confirm)
            return { kind: 'error', text: ctx.copy.passwordMismatch }
        return undefined
    }
    const mailFailure = (ctx: PageContext, code: string) => {
        if (code === 'InvalidAccountEmail')
            return { status: 400, text: ctx.copy.invalidEmail }
        if (code === 'TooManyRequests')
            return { status: 429, text: ctx.copy.rateLimit }
        if (code === 'MailUnavailable')
            return { status: 503, text: ctx.copy.mailUnavailable }
        if (code === 'InvalidPassword')
            return {
                status: 400,
                text: fill(ctx.copy.passwordTooShort, { min: MIN_PASSWORD })
            }
        return { status: 503, text: ctx.copy.unavailable }
    }

    const router = express.Router()
    router.get('/login.css', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=31536000, immutable')
            .type('css')
            .send(css)
    })

    router.use('/fonts', fontRoute)

    // Every form post: from the login site itself (CSRF, with SameSite), within the per-address limit.
    router.post(
        FORM_PATHS,
        (req, res, next) => {
            if (req.headers.origin !== loginOrigin)
                return fail(req, res, 403, contextOf(req).copy.flowFailed)
            next()
        },
        async (req, res, next) => {
            try {
                if (await deps.limited(`login-form:${req.ip ?? 'unknown'}`, 20))
                    return fail(req, res, 429, contextOf(req).copy.rateLimit)
            } catch {
                return fail(req, res, 503, contextOf(req).copy.unavailable)
            }
            next()
        },
        express.urlencoded({
            extended: false,
            limit: '16kb',
            parameterLimit: 20
        })
    )

    router.get('/sign-in', async (req, res) => {
        // The provider appends its signed query to /sign-in; our own links use `oauth_query`.
        const raw =
            queryField(req, 'oauth_query') ||
            (req.originalUrl.split('?')[1] ?? '')
        const flow = await flows.read(raw)
        if (flow.kind === 'invalid') return flowFailed(req, res)
        if (flow.kind === 'expired') return res.redirect(302, flow.restart)
        send(res, 200, signInPage(contextOf(req, flow)))
    })

    router.post('/sign-in', async (req, res) => {
        const flow = await flows.read(field(req.body, 'oauth_query'))
        if (flow.kind === 'invalid') return flowFailed(req, res)
        const ctx = contextOf(req, flow)
        const email = field(req.body, 'email')
        const result = await actions.signIn(
            email,
            field(req.body, 'password'),
            fromNodeHeaders(req.headers),
            flow.kind === 'valid' ? flow.query : undefined
        )
        if (result.ok) {
            for (const cookie of result.value.setCookie)
                res.append('Set-Cookie', cookie)
            dropFlow(res)
            if (flow.kind === 'valid' && result.value.redirect)
                return res.redirect(302, result.value.redirect)
            if (flow.kind === 'expired') return res.redirect(302, flow.restart)
            return send(
                res,
                200,
                noticePage(ctx, ctx.copy.signedInTitle, ctx.copy.signedIn)
            )
        }
        // The query expired between reading it and signing in: start the flow again.
        if (result.code === 'InvalidLink')
            return flow.kind === 'valid' && flow.restart
                ? res.redirect(302, flow.restart)
                : flowFailed(req, res)
        if (result.code === 'EmailNotVerified') {
            keepFlow(res, flow)
            keepEmail(res, email)
            return send(
                res,
                200,
                checkEmailPage(ctx, {
                    email,
                    message: { kind: 'error', text: ctx.copy.emailNotVerified }
                })
            )
        }
        const [status, text] =
            result.code === 'TooManyRequests'
                ? [429, ctx.copy.rateLimit]
                : result.code === 'AccountUnavailable'
                  ? [503, ctx.copy.unavailable]
                  : [401, ctx.copy.invalidCredentials]
        send(
            res,
            status,
            signInPage(ctx, { email, message: { kind: 'error', text } })
        )
    })

    router.get('/create-account', async (req, res) => {
        const flow = await flows.read(queryField(req, 'oauth_query'))
        if (flow.kind === 'invalid') return flowFailed(req, res)
        send(res, 200, createAccountPage(contextOf(req, flow)))
    })

    router.post('/create-account', async (req, res) => {
        const flow = await flows.read(field(req.body, 'oauth_query'))
        if (flow.kind === 'invalid') return flowFailed(req, res)
        const ctx = contextOf(req, flow)
        const name = field(req.body, 'name').trim()
        const email = field(req.body, 'email')
        const password = field(req.body, 'password')
        const problem: Message =
            !name || name.length > MAX_NAME
                ? { kind: 'error', text: ctx.copy.nameRequired }
                : passwordProblem(ctx, password, field(req.body, 'confirm'))
        if (problem)
            return send(
                res,
                400,
                createAccountPage(ctx, { name, email, message: problem })
            )
        const result = await actions.register(email, password, name)
        if (!result.ok) {
            const { status, text } = mailFailure(ctx, result.code)
            return send(
                res,
                status,
                createAccountPage(ctx, {
                    name,
                    email,
                    message: { kind: 'error', text }
                })
            )
        }
        keepFlow(res, flow)
        keepEmail(res, email.trim().toLowerCase())
        res.redirect(
            303,
            ctx.flow
                ? `/check-email?${new URLSearchParams({ oauth_query: ctx.flow })}`
                : '/check-email'
        )
    })

    router.get('/check-email', async (req, res) => {
        const flow = lenient(await flows.read(queryField(req, 'oauth_query')))
        send(
            res,
            200,
            checkEmailPage(contextOf(req, flow), { email: pendingEmail(req) })
        )
    })

    router.post('/verify-code', async (req, res) => {
        const flow = lenient(await flows.read(field(req.body, 'oauth_query')))
        const ctx = contextOf(req, flow)
        const email = field(req.body, 'email')
        const result = await actions.verifyEmailCode(
            email,
            field(req.body, 'code').trim()
        )
        if (!result.ok) {
            const [status, text] =
                result.code === 'TooManyRequests'
                    ? [429, ctx.copy.rateLimit]
                    : [400, ctx.copy.invalidCode]
            return send(
                res,
                status,
                checkEmailPage(ctx, {
                    email,
                    message: { kind: 'error', text }
                })
            )
        }
        dropEmail(res)
        send(
            res,
            200,
            signInPage(ctx, {
                email,
                message: { kind: 'notice', text: ctx.copy.emailConfirmed }
            })
        )
    })

    router.post('/check-email', async (req, res) => {
        const flow = lenient(await flows.read(field(req.body, 'oauth_query')))
        const ctx = contextOf(req, flow)
        const email = field(req.body, 'email')
        const result = await actions.resendVerification(email)
        if (!result.ok) {
            const { status, text } = mailFailure(ctx, result.code)
            return send(
                res,
                status,
                checkEmailPage(ctx, {
                    email,
                    message: { kind: 'error', text }
                })
            )
        }
        keepFlow(res, flow)
        keepEmail(res, email.trim().toLowerCase())
        send(
            res,
            200,
            checkEmailPage(ctx, {
                email,
                message: { kind: 'notice', text: ctx.copy.codeSent }
            })
        )
    })

    /** On pages opened from a mail link, the flow comes back from this browser's cookie. */
    const mailFlow = async (req: Request) =>
        lenient(
            await flows.read(
                queryField(req, 'oauth_query') ||
                    cookieOf(req.headers, flowCookie)
            )
        )
    const validToken = (token: string) =>
        token.length >= 16 && token.length <= 512

    // Opening the link never uses the token, so mail scanners cannot use it up.
    router.get('/confirm', async (req, res) => {
        const token = queryField(req, 'token')
        const ctx = contextOf(req, await mailFlow(req))
        if (!validToken(token)) return fail(req, res, 400, ctx.copy.invalidLink)
        send(res, 200, confirmPage(ctx, token))
    })

    router.post('/confirm', async (req, res) => {
        const flow = lenient(await flows.read(field(req.body, 'oauth_query')))
        const ctx = contextOf(req, flow)
        const result = await actions.verifyEmail(field(req.body, 'token'))
        if (!result.ok) return fail(req, res, 400, ctx.copy.invalidLink)
        send(
            res,
            200,
            signInPage(ctx, {
                message: { kind: 'notice', text: ctx.copy.emailConfirmed }
            })
        )
    })

    router.get('/forgot-password', async (req, res) => {
        const flow = await flows.read(queryField(req, 'oauth_query'))
        if (flow.kind === 'invalid') return flowFailed(req, res)
        send(res, 200, forgotPasswordPage(contextOf(req, flow)))
    })

    router.post('/forgot-password', async (req, res) => {
        const flow = lenient(await flows.read(field(req.body, 'oauth_query')))
        const ctx = contextOf(req, flow)
        const email = field(req.body, 'email')
        const result = await actions.forgotPassword(email)
        if (!result.ok) {
            const { status, text } = mailFailure(ctx, result.code)
            return send(
                res,
                status,
                forgotPasswordPage(ctx, {
                    email,
                    message: { kind: 'error', text }
                })
            )
        }
        keepFlow(res, flow)
        send(
            res,
            200,
            forgotPasswordPage(ctx, {
                email,
                message: { kind: 'notice', text: ctx.copy.resetSent }
            })
        )
    })

    router.get('/reset-password', async (req, res) => {
        const token = queryField(req, 'token')
        const ctx = contextOf(req, await mailFlow(req))
        if (!validToken(token))
            return fail(req, res, 400, ctx.copy.resetLinkMissing)
        send(res, 200, resetPasswordPage(ctx, token))
    })

    router.post('/reset-password', async (req, res) => {
        const flow = lenient(await flows.read(field(req.body, 'oauth_query')))
        const ctx = contextOf(req, flow)
        const token = field(req.body, 'token')
        const password = field(req.body, 'password')
        const problem = passwordProblem(
            ctx,
            password,
            field(req.body, 'confirm')
        )
        if (problem)
            return send(
                res,
                400,
                resetPasswordPage(ctx, token, { message: problem })
            )
        const result = await actions.resetPassword(token, password)
        if (!result.ok) {
            if (result.code === 'InvalidPassword')
                return send(
                    res,
                    400,
                    resetPasswordPage(ctx, token, {
                        message: {
                            kind: 'error',
                            text: fill(ctx.copy.passwordTooShort, {
                                min: MIN_PASSWORD
                            })
                        }
                    })
                )
            return fail(
                req,
                res,
                result.code === 'InvalidLink' ? 400 : 503,
                result.code === 'InvalidLink'
                    ? ctx.copy.invalidLink
                    : ctx.copy.unavailable
            )
        }
        send(
            res,
            200,
            signInPage(ctx, {
                message: { kind: 'notice', text: ctx.copy.passwordChanged }
            })
        )
    })

    /**
     * Where sign-out returns: a registered post-logout address of a configured
     * client (exact match, with `state` added as OIDC asks), otherwise our own
     * signed-out page. Only checked values are carried on the confirm page.
     */
    const logoutRequestOf = (values: (name: string) => string) => {
        const clientId = values('client_id')
        const uri = values('post_logout_redirect_uri')
        const state = values('state').slice(0, 512)
        const client = deps.clients.find((entry) => entry.clientId === clientId)
        if (!client || !uri || !client.postLogoutRedirectUris.includes(uri))
            return {
                target: '/signed-out',
                carried: { clientId: '', postLogoutRedirectUri: '', state: '' }
            }
        const target = new URL(uri)
        if (state) target.searchParams.set('state', state)
        return {
            target: target.toString(),
            carried: { clientId, postLogoutRedirectUri: uri, state }
        }
    }
    const loginSessionOf = (req: Request) =>
        deps.auth.api.getSession({
            headers: fromNodeHeaders(req.headers),
            query: { disableRefresh: true }
        })
    /** Ends the login-site session through better-auth's own sign-out; its cookie changes go to the browser. */
    const endLoginSession = async (req: Request, res: Response) => {
        const headers = fromNodeHeaders(req.headers)
        const names: string[] = []
        headers.forEach((_value, name) => {
            names.push(name)
        })
        for (const name of names)
            if (name.startsWith('sec-fetch-')) headers.delete(name)
        headers.delete('content-length')
        headers.set('content-type', 'application/json')
        headers.set('accept', 'application/json')
        // POST came from our own form (Origin checked); GET carries a verified ticket.
        headers.set('origin', loginOrigin)
        const response = await deps.auth.handler(
            new globalThis.Request(`${loginOrigin}/api/auth/sign-out`, {
                method: 'POST',
                headers,
                body: '{}'
            })
        )
        if (!response.ok) return false
        for (const cookie of response.headers.getSetCookie())
            res.append('Set-Cookie', cookie)
        return true
    }

    // RP-initiated logout (`/api/auth/oauth2/end-session` redirects here).
    router.get('/sign-out', async (req, res) => {
        const { target, carried } = logoutRequestOf((name) =>
            queryField(req, name)
        )
        const current = await loginSessionOf(req)
        if (!current) return res.redirect(302, target)
        // One click: the API's ticket names exactly this person.
        const ticketUser = readLogoutTicket(
            (await deps.auth.$context).secret,
            queryField(req, 'ticket')
        )
        if (ticketUser && ticketUser === current.user.id) {
            if (!(await endLoginSession(req, res)))
                return fail(req, res, 503, contextOf(req).copy.unavailable)
            return res.redirect(302, target)
        }
        // Only the validated request is carried over to the other language.
        const params = new URLSearchParams()
        if (carried.clientId) params.set('client_id', carried.clientId)
        if (carried.postLogoutRedirectUri)
            params.set(
                'post_logout_redirect_uri',
                carried.postLogoutRedirectUri
            )
        if (carried.state) params.set('state', carried.state)
        send(
            res,
            200,
            signOutPage(
                {
                    ...contextOf(req),
                    current: params.size ? `/sign-out?${params}` : '/sign-out'
                },
                carried
            )
        )
    })

    router.post('/sign-out', async (req, res) => {
        const { target } = logoutRequestOf((name) => field(req.body, name))
        if (!(await loginSessionOf(req))) return res.redirect(303, target)
        if (!(await endLoginSession(req, res)))
            return fail(req, res, 503, contextOf(req).copy.unavailable)
        res.redirect(303, target)
    })

    router.get('/signed-out', (req, res) => {
        const ctx = contextOf(req)
        send(
            res,
            200,
            noticePage(ctx, ctx.copy.signedOutTitle, ctx.copy.signedOut)
        )
    })

    // First version: only first-party clients, which skip consent.
    router.get('/consent', (req, res) =>
        fail(req, res, 403, contextOf(req).copy.consentUnavailable)
    )

    // The provider's own error landing; its description is never shown.
    router.get('/error', (req, res) => {
        const ctx = contextOf(req)
        fail(
            req,
            res,
            400,
            UNKNOWN_CLIENT_ERRORS.has(queryField(req, 'error'))
                ? ctx.copy.unknownClient
                : ctx.copy.flowFailed
        )
    })

    return router
}

/** Advertised client authentication: what the configured clients use (secret in the body, or none). */
const TOKEN_AUTH_METHODS = ['client_secret_post', 'none']
/** Discovery fields for endpoints the login host does not serve or methods no client uses. */
const UNADVERTISED = [
    'introspection_endpoint',
    'introspection_endpoint_auth_methods_supported',
    'introspection_endpoint_auth_signing_alg_values_supported',
    'revocation_endpoint',
    'revocation_endpoint_auth_methods_supported',
    'revocation_endpoint_auth_signing_alg_values_supported',
    // Only for private_key_jwt / client_secret_jwt, which no client uses.
    'token_endpoint_auth_signing_alg_values_supported'
]

/**
 * The discovery document as the login host publishes it. The add-on's
 * `advertisedMetadata` option only covers scopes and claims, and its metadata
 * extensions can only add fields, so the rest is trimmed here.
 */
export function trimDiscovery(document: Record<string, unknown>) {
    const trimmed = { ...document }
    for (const key of UNADVERTISED) delete trimmed[key]
    trimmed.token_endpoint_auth_methods_supported = [...TOKEN_AUTH_METHODS]
    return trimmed
}

/**
 * A provider answer as the login host sends it: our security headers stay (the
 * provider's CSP is dropped), discovery is trimmed, and no provider HTML is
 * ever shown; an HTML answer becomes our own error page.
 */
async function shaped(
    request: globalThis.Request,
    response: globalThis.Response
) {
    const headers = new Headers(response.headers)
    headers.delete('content-security-policy')
    const type = headers.get('content-type') ?? ''
    if (type.includes('text/html')) {
        const lang = resolveLanguage(
            request.headers.get('cookie') ?? undefined,
            request.headers.get('accept-language') ?? undefined
        )
        const copy = copies[lang]
        return new globalThis.Response(
            noticePage(
                {
                    lang,
                    copy,
                    service: DEFAULT_SERVICE,
                    flow: '',
                    stylesheet,
                    theme: themeOf(request.headers.get('cookie') ?? undefined)
                },
                copy.errorTitle,
                copy.flowFailed
            ),
            {
                status: response.status >= 400 ? response.status : 400,
                headers: {
                    'Content-Type': 'text/html; charset=utf-8',
                    'Cache-Control': 'no-store'
                }
            }
        )
    }
    if (
        new URL(request.url).pathname === DISCOVERY_PATH &&
        response.ok &&
        type.includes('application/json')
    ) {
        const document = trimDiscovery(
            (await response.json()) as Record<string, unknown>
        )
        headers.delete('content-length')
        return new globalThis.Response(
            request.method === 'HEAD' ? null : JSON.stringify(document),
            { status: response.status, headers }
        )
    }
    return new globalThis.Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
    })
}

const tooMany = (req: Request, res: Response) => {
    res.status(429).set('Retry-After', '60')
    if (req.accepts(['json', 'html']) === 'html') {
        const lang = languageOf(req)
        const copy = copies[lang]
        return res.type('html').send(
            noticePage(
                {
                    lang,
                    copy,
                    service: DEFAULT_SERVICE,
                    flow: '',
                    stylesheet,
                    theme: themeOf(req.headers.cookie)
                },
                copy.errorTitle,
                copy.rateLimit
            )
        )
    }
    res.json({
        error: 'temporarily_unavailable',
        error_description: 'Too many requests'
    })
}

const notFound = (): RequestHandler => (req, res) => {
    const copy = copies[languageOf(req)]
    res.status(404)
        .type('html')
        .send(
            noticePage(
                {
                    lang: languageOf(req),
                    copy,
                    service: DEFAULT_SERVICE,
                    flow: '',
                    stylesheet,
                    theme: themeOf(req.headers.cookie)
                },
                copy.errorTitle,
                copy.notFound
            )
        )
}

const failed: ErrorRequestHandler = (error, req, res, _next) => {
    // Never log the request: its query or body may hold tokens or passwords.
    const status =
        typeof error?.status === 'number' &&
        error.status >= 400 &&
        error.status < 500
            ? error.status
            : 500
    if (status === 500) console.error('Login page failed')
    if (res.headersSent) return
    const lang = languageOf(req)
    const copy = copies[lang]
    res.status(status)
        .type('html')
        .send(
            noticePage(
                {
                    lang,
                    copy,
                    service: DEFAULT_SERVICE,
                    flow: '',
                    stylesheet,
                    theme: themeOf(req.headers.cookie)
                },
                copy.errorTitle,
                status === 500 ? copy.unavailable : copy.flowFailed
            )
        )
}

/**
 * Everything the login host answers: security headers, the allow-listed
 * provider routes (forwarded unchanged to better-auth), the login pages, and
 * 404 for everything else, including the API's own routes.
 */
export function createLoginHost(deps: LoginDeps): express.Router {
    const host = express.Router()
    const provider = toNodeHandler((request: globalThis.Request) =>
        deps.auth.handler(request).then((response) => shaped(request, response))
    )
    const endSessionBody = express.urlencoded({
        extended: false,
        limit: '16kb',
        parameterLimit: 20
    })
    host.use(securityHeaders(formTargetsOf(deps.clients)))
    host.get('/language', languageRoute(deps.loginOrigin.startsWith('https:')))
    host.get('/theme', themeRoute(deps.loginOrigin.startsWith('https:')))
    // End-session is ours: the same request goes to /sign-out (HAWConnect page,
    // de/en, our policy), never to the add-on's own logout pages.
    host.use((req, res, next) => {
        if (req.path !== END_SESSION_PATH) return next()
        if (req.method === 'GET' || req.method === 'HEAD') {
            const query = req.originalUrl.split('?')[1]
            return res.redirect(302, query ? `/sign-out?${query}` : '/sign-out')
        }
        if (req.method !== 'POST') return res.status(405).end()
        endSessionBody(req, res, (error?: unknown) => {
            if (error) return next(error)
            const params = new URLSearchParams()
            for (const [name, value] of Object.entries(req.body ?? {}))
                if (typeof value === 'string') params.set(name, value)
            res.redirect(303, params.size ? `/sign-out?${params}` : '/sign-out')
        })
    })
    host.use(async (req, res, next) => {
        if (!PROVIDER_PATHS.has(req.path)) return next()
        try {
            if (
                await deps.limited(
                    `provider:${req.ip ?? 'unknown'}`,
                    PROVIDER_LIMIT
                )
            )
                return tooMany(req, res)
        } catch {
            return next(new Error('LimitUnavailable'))
        }
        provider(req, res).catch(next)
    })
    host.use(createLoginRouter(deps))
    host.use(notFound())
    host.use(failed)
    return host
}

/** The login host while accounts are off: every request gets the "unavailable" page. */
export function unavailableLoginHost(loginOrigin: string): express.Router {
    const host = express.Router()
    host.use(securityHeaders([]))
    host.get('/language', languageRoute(loginOrigin.startsWith('https:')))
    host.get('/theme', themeRoute(loginOrigin.startsWith('https:')))
    host.use('/login.css', (_req, res) => {
        res.set('Cache-Control', 'public, max-age=31536000, immutable')
            .type('css')
            .send(css)
    })
    host.use('/fonts', fontRoute)
    host.use((req, res) => {
        const lang = languageOf(req)
        const copy = copies[lang]
        res.status(503)
            .type('html')
            .send(
                noticePage(
                    {
                        lang,
                        copy,
                        service: DEFAULT_SERVICE,
                        flow: '',
                        stylesheet,
                        theme: themeOf(req.headers.cookie),
                        current: currentOf(req)
                    },
                    copy.errorTitle,
                    copy.unavailable
                )
            )
    })
    return host
}

/**
 * Sends requests for the login origin's host to `site`; every other host keeps
 * the routes mounted after this.
 */
export function loginHostGate(
    loginOrigin: string,
    site: RequestHandler
): RequestHandler {
    return (req, res, next) => {
        if (!isLoginHost(req.headers, loginOrigin)) return next()
        site(req, res, (error?: unknown) => {
            // The login host never falls through to the API's routes.
            if (error) return next(error)
            res.status(404).end()
        })
    }
}
