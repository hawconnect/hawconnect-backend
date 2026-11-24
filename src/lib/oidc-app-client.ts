import {
    createHash,
    createHmac,
    randomBytes,
    timingSafeEqual
} from 'node:crypto'
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose'
import { normaliseAccountEmail } from '@/utils/account-policy'
import type { AccountAuthService } from './account-auth'
import { createAppSession } from './app-session'
import { createLogoutTicket } from './logout-ticket'

type Auth = AccountAuthService['auth']

export const APP_CLIENT_ID = 'hawconnect-app'
export const NATIVE_REDIRECT = 'hawconnect://auth/callback'
const SCOPE = 'openid email'
const STATE_PATH = '/api/accounts/oidc'
const STATE_MAX_AGE = 600
const ID_TOKEN_ALGORITHMS = ['EdDSA', 'ES256', 'ES512', 'RS256', 'PS256']

/** A path inside the web app (`/marketplace/abc`); anything else becomes `/`. */
export function safeReturnPath(value: unknown): string {
    return typeof value === 'string' &&
        /^\/[A-Za-z0-9/_-]*$/.test(value) &&
        !value.startsWith('//')
        ? value
        : '/'
}

type Failure =
    | 'provider_error'
    | 'state'
    | 'issuer'
    | 'input'
    | 'redemption'
    | 'id_token'
    | 'session'

/** Fixed lines only: never the code, a token, an email or a query string. */
const logFailure = (category: Failure) => {
    if (process.env.NODE_ENV !== 'test')
        console.warn(`OIDC sign-in failed: ${category}`)
}

const random = (bytes: number) => randomBytes(bytes).toString('base64url')
const challengeOf = (verifier: string) =>
    createHash('sha256').update(verifier).digest('base64url')
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/

type ExchangeResult =
    | {
          ok: true
          value: { user: { id: string; email: string }; token: string }
      }
    | { ok: false; code: 'InvalidLink' | 'AccountUnavailable' }

type StateValue = {
    state: string
    nonce: string
    verifier: string
    returnPath: string
    createdAt: number
}

const sameText = (a: string, b: string) => {
    const left = Buffer.from(a)
    const right = Buffer.from(b)
    return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Redeems a code at the provider's token endpoint (in process, client_secret_post),
 * revokes the access token at once and verifies the ID token. Returns the person.
 */
export async function redeemAuthorizationCode(
    config: {
        auth: Auth
        loginOrigin: string
        clientId: string
        clientSecret?: string
    },
    input: {
        code: string
        verifier: string
        redirectUri: string
        nonce: string
    }
): Promise<
    | { ok: true; userId: string; sessionId?: string }
    | { ok: false; why: Failure }
> {
    const loginOrigin = new URL(config.loginOrigin).origin
    const provider = (path: string, init?: RequestInit) =>
        config.auth.handler(new Request(`${loginOrigin}/api/auth${path}`, init))
    const form = (values: Record<string, string>) => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(values)
    })
    if (!config.clientSecret) return { ok: false, why: 'redemption' }
    const response = await provider(
        '/oauth2/token',
        form({
            grant_type: 'authorization_code',
            code: input.code,
            redirect_uri: input.redirectUri,
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code_verifier: input.verifier
        })
    )
    if (response.status !== 200) return { ok: false, why: 'redemption' }
    const tokens = (await response.json().catch(() => ({}))) as {
        id_token?: unknown
        access_token?: unknown
        refresh_token?: unknown
    }
    // The app never sees provider tokens; the access token is revoked right away.
    // (No refresh token is issued: the app does not ask for offline_access.)
    for (const [token, hint] of [
        [tokens.access_token, 'access_token'],
        [tokens.refresh_token, 'refresh_token']
    ] as const)
        if (typeof token === 'string')
            await provider(
                '/oauth2/revoke',
                form({
                    token,
                    token_type_hint: hint,
                    client_id: config.clientId,
                    client_secret: config.clientSecret
                })
            ).catch(() => undefined)
    if (typeof tokens.id_token !== 'string')
        return { ok: false, why: 'id_token' }
    try {
        const jwks = await provider('/jwks')
        if (!jwks.ok) return { ok: false, why: 'id_token' }
        const keys = createLocalJWKSet((await jwks.json()) as JSONWebKeySet)
        const { payload } = await jwtVerify(tokens.id_token, keys, {
            issuer: loginOrigin,
            audience: config.clientId,
            algorithms: ID_TOKEN_ALGORITHMS,
            requiredClaims: ['sub', 'exp', 'iat', 'nonce']
        })
        const audiences = Array.isArray(payload.aud)
            ? payload.aud
            : [payload.aud]
        if (audiences.length > 1 && payload.azp !== config.clientId)
            return { ok: false, why: 'id_token' }
        if (
            typeof payload.nonce !== 'string' ||
            !sameText(payload.nonce, input.nonce)
        )
            return { ok: false, why: 'id_token' }
        if (typeof payload.sub !== 'string' || !payload.sub)
            return { ok: false, why: 'id_token' }
        return {
            ok: true,
            userId: payload.sub,
            // The login-site session the code came from (emitted because end-session is enabled).
            sessionId:
                typeof payload.sid === 'string' && payload.sid
                    ? payload.sid
                    : undefined
        }
    } catch {
        return { ok: false, why: 'id_token' }
    }
}

export function createOidcAppClient(config: {
    auth: Auth
    /** The account secret; signs the state cookie. */
    secret: string
    /** The API origin; the web callback lives here. */
    apiOrigin: string
    loginOrigin: string
    webOrigin: string
    clientSecret?: string
}) {
    const apiOrigin = new URL(config.apiOrigin).origin
    const loginOrigin = new URL(config.loginOrigin).origin
    const webOrigin = new URL(config.webOrigin).origin
    const webRedirect = `${apiOrigin}${STATE_PATH}/callback`
    const secure = new URL(apiOrigin).protocol === 'https:'
    // `__Host-` requires Path=/, so the path-scoped cookie uses `__Secure-` under https.
    const stateCookie = `${secure ? '__Secure-' : ''}hawconnect.oidc_state`
    const failedURL = `${webOrigin}/login?error=sign-in-failed`
    const cookieAttributes = (maxAge: number) =>
        `Path=${STATE_PATH}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
    const clearState = `${stateCookie}=; ${cookieAttributes(0)}`

    const sign = (payload: string) =>
        createHmac('sha256', config.secret)
            .update(`hawconnect.oidc_state:${payload}`)
            .digest('base64url')
    const sealState = (value: StateValue) => {
        const payload = Buffer.from(JSON.stringify(value)).toString('base64url')
        return `${payload}.${sign(payload)}`
    }
    const openState = (raw: string | undefined): StateValue | null => {
        if (!raw) return null
        const [payload, signature, extra] = raw.split('.')
        if (!payload || !signature || extra !== undefined) return null
        const expected = Buffer.from(sign(payload))
        const given = Buffer.from(signature)
        if (
            expected.length !== given.length ||
            !timingSafeEqual(expected, given)
        )
            return null
        try {
            const value = JSON.parse(
                Buffer.from(payload, 'base64url').toString()
            ) as StateValue
            if (
                typeof value.state !== 'string' ||
                typeof value.nonce !== 'string' ||
                typeof value.verifier !== 'string' ||
                typeof value.createdAt !== 'number' ||
                Date.now() - value.createdAt > STATE_MAX_AGE * 1000 ||
                value.createdAt > Date.now() + 60_000
            )
                return null
            return { ...value, returnPath: safeReturnPath(value.returnPath) }
        } catch {
            return null
        }
    }
    const cookieValue = (header: string | null) => {
        for (const part of (header ?? '').split(';')) {
            const index = part.indexOf('=')
            if (index > 0 && part.slice(0, index).trim() === stateCookie)
                return part.slice(index + 1).trim()
        }
        return undefined
    }
    const same = (a: string, b: string) => {
        const left = Buffer.from(a)
        const right = Buffer.from(b)
        return left.length === right.length && timingSafeEqual(left, right)
    }

    const redeem = (input: {
        code: string
        verifier: string
        redirectUri: string
        nonce: string
    }) =>
        redeemAuthorizationCode(
            {
                auth: config.auth,
                loginOrigin,
                clientId: APP_CLIENT_ID,
                clientSecret: config.clientSecret
            },
            input
        )

    async function startSession(userId: string) {
        const context = await config.auth.$context
        const user = await context.internalAdapter.findUserById(userId)
        if (!user) return null
        try {
            normaliseAccountEmail(user.email)
        } catch {
            return null
        }
        const session = await createAppSession(config.auth, userId)
        return { user: { id: user.id, email: user.email }, ...session }
    }

    /**
     * Ends the login-site session a phone sign-in left behind. On Android the
     * sign-in sheet shares the browser's cookies, so that session would sign
     * the next person in without a password. Only a session of the same person.
     */
    async function endLoginSession(sessionId: string, userId: string) {
        const context = await config.auth.$context
        const session = await context.adapter.findOne<{
            id: string
            userId: string
            token: string
        }>({ model: 'session', where: [{ field: 'id', value: sessionId }] })
        if (session && session.userId === userId)
            await context.internalAdapter.deleteSession(session.token)
    }

    const redirect = (location: string, cookies: string[]) => {
        const headers = new Headers({
            Location: location,
            'Cache-Control': 'no-store'
        })
        for (const cookie of cookies) headers.append('Set-Cookie', cookie)
        return new Response(null, { status: 302, headers })
    }
    const fail = (why: Failure) => {
        logFailure(why)
        return redirect(failedURL, [clearState])
    }

    /** `GET /api/accounts/oidc/start?return=<path>` */
    function start(request: Request): Response {
        if (!config.clientSecret) return fail('redemption')
        const url = new URL(request.url)
        const value: StateValue = {
            state: random(32),
            nonce: random(32),
            verifier: random(48),
            returnPath: safeReturnPath(url.searchParams.get('return')),
            createdAt: Date.now()
        }
        const authorize = new URL(`${loginOrigin}/api/auth/oauth2/authorize`)
        authorize.search = new URLSearchParams({
            response_type: 'code',
            client_id: APP_CLIENT_ID,
            redirect_uri: webRedirect,
            scope: SCOPE,
            state: value.state,
            nonce: value.nonce,
            code_challenge: challengeOf(value.verifier),
            code_challenge_method: 'S256'
        }).toString()
        return redirect(authorize.toString(), [
            `${stateCookie}=${sealState(value)}; ${cookieAttributes(STATE_MAX_AGE)}`
        ])
    }

    /** `GET /api/accounts/oidc/callback?code&state&iss` */
    async function callback(request: Request): Promise<Response> {
        try {
            const query = new URL(request.url).searchParams
            if (query.has('error')) return fail('provider_error')
            const saved = openState(cookieValue(request.headers.get('cookie')))
            const state = query.get('state') ?? ''
            if (!saved || !same(saved.state, state)) return fail('state')
            // RFC 9207: the response must come from our login site.
            const iss = query.get('iss')
            if (iss !== null && iss !== loginOrigin) return fail('issuer')
            const code = query.get('code') ?? ''
            if (!code || code.length > 512) return fail('input')
            const result = await redeem({
                code,
                verifier: saved.verifier,
                redirectUri: webRedirect,
                nonce: saved.nonce
            })
            if (!result.ok) return fail(result.why)
            const session = await startSession(result.userId)
            if (!session) return fail('session')
            return redirect(`${webOrigin}${saved.returnPath}`, [
                clearState,
                ...session.setCookie
            ])
        } catch {
            return fail('session')
        }
    }

    /** `POST /api/accounts/oidc/exchange` for the phone apps. */
    async function exchange(
        body: Record<string, unknown>
    ): Promise<ExchangeResult> {
        const { code, codeVerifier, redirectUri, nonce } = body
        if (
            redirectUri !== NATIVE_REDIRECT ||
            typeof code !== 'string' ||
            !code ||
            code.length > 512 ||
            typeof codeVerifier !== 'string' ||
            !VERIFIER.test(codeVerifier) ||
            typeof nonce !== 'string' ||
            !nonce ||
            nonce.length > 512
        ) {
            logFailure('input')
            return { ok: false, code: 'InvalidLink' }
        }
        if (!config.clientSecret)
            return { ok: false, code: 'AccountUnavailable' }
        const result = await redeem({
            code,
            verifier: codeVerifier,
            redirectUri: NATIVE_REDIRECT,
            nonce
        })
        if (!result.ok) {
            logFailure(result.why)
            return { ok: false, code: 'InvalidLink' }
        }
        const session = await startSession(result.userId)
        if (!session) {
            logFailure('session')
            return { ok: false, code: 'InvalidLink' }
        }
        if (result.sessionId)
            await endLoginSession(result.sessionId, result.userId).catch(() =>
                logFailure('session')
            )
        return { ok: true, value: { user: session.user, token: session.token } }
    }

    /**
     * The login site's end-session address for the web app's sign-out, with a
     * short-lived ticket naming the person, so the login site can end their
     * session in one step without the app keeping an ID token.
     */
    const endSessionUrl = (userId: string) =>
        `${loginOrigin}/api/auth/oauth2/end-session?${new URLSearchParams({
            client_id: APP_CLIENT_ID,
            post_logout_redirect_uri: `${webOrigin}/`,
            ticket: createLogoutTicket(config.secret, userId)
        })}`

    return { start, callback, exchange, endSessionUrl }
}
