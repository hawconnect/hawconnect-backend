import { createHash } from 'node:crypto'
import { betterAuth } from 'better-auth'
import { bearer, emailOTP, magicLink } from 'better-auth/plugins'
import type { Pool } from 'pg'
import { normaliseAccountEmail } from '@/utils/account-policy'
import {
    type ActionCode,
    createAccountActions,
    MAX_PASSWORD,
    MIN_PASSWORD
} from './account-actions'
import { createOidcAppClient } from './oidc-app-client'
import { oidcPlugins } from './oidc-provider'

export interface AccountMail {
    email: string
    url: string
    /** Which mail to send; `link` is the legacy single-use sign-in link (dashboard only). */
    kind?: 'link' | 'verify' | 'reset' | 'exists'
    /** `verify` only: the 6-digit code typed on the login site (the link works too). */
    code?: string
}
interface AccountAuthConfig {
    pool: Pool
    secret: string
    baseURL: string
    /**
     * The login site and OpenID Connect issuer (`https://account.hawconnect.de`).
     * Required for public accounts; when set, better-auth runs at this origin.
     */
    loginOrigin?: string
    webOrigin: string
    passwordLogin?: boolean
    /** Public accounts: register with email + password, confirm the email, reset the password. */
    registration?: boolean
    /** Legacy emailed single-use sign-in link (kept for the admin dashboard). */
    signInLink?: boolean
    send?: (message: AccountMail) => Promise<void>
    /** `hawconnect-app`'s client secret; the API redeems the app's codes with it. */
    appClientSecret?: string
}
const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })

/**
 * Runs after better-auth has already changed the password, so it must never
 * fail: a thrown error would turn a completed reset into "invalid link". One
 * retry, then a fixed log line (no user, no error text).
 */
export async function revokeAfterReset(
    revoke: () => Promise<void>,
    log: (line: string) => void = console.error
) {
    for (let attempt = 0; attempt < 2; attempt++)
        try {
            await revoke()
            return
        } catch {}
    log('Provider tokens not revoked after password reset')
}

/** Wrong tries allowed per code; then a new code is needed. */
export const CODE_ATTEMPTS = 5

export function createAccountAuth(config: AccountAuthConfig) {
    if (config.secret.length < 32) throw new Error('AccountSecretRequired')
    if (config.registration && !config.loginOrigin)
        throw new Error('LoginOriginRequired')
    const baseURL = config.loginOrigin
        ? new URL(config.loginOrigin).origin
        : config.baseURL
    const webOrigin = new URL(config.webOrigin).origin
    const landing = (path: string, params: Record<string, string>) => {
        const url = new URL(path, webOrigin)
        url.hash = new URLSearchParams(params).toString()
        return url.toString()
    }
    /** Mail links for public accounts open on the login site, token in the query. */
    const loginLink = (path: string, token: string) => {
        const url = new URL(path, baseURL)
        url.searchParams.set('token', token)
        return url.toString()
    }
    const deliver = async (message: AccountMail) => {
        if (!config.send) throw new Error('MailUnavailable')
        await config.send(message)
    }
    /** A fresh code replaces any earlier one for the address. */
    const newConfirmationCode = async (email: string) => {
        const context = await auth.$context
        await context.internalAdapter.deleteVerificationByIdentifier(
            `email-verification-otp-${email}`
        )
        return auth.api.createVerificationOTP({
            body: { email, type: 'email-verification' }
        })
    }
    const auth = betterAuth({
        appName: 'HAWConnect',
        baseURL,
        secret: config.secret,
        database: config.pool,
        telemetry: { enabled: false },
        logger: { disabled: true },
        // Provider errors that must not go back to a client land on the login site's page.
        ...(config.loginOrigin
            ? {
                  onAPIError: {
                      errorURL: new URL('/error', baseURL).toString()
                  }
              }
            : {}),
        trustedOrigins: [webOrigin, 'hawconnect://'],
        emailAndPassword: {
            enabled:
                config.passwordLogin === true || config.registration === true,
            disableSignUp: config.registration !== true,
            requireEmailVerification: true,
            minPasswordLength: config.registration ? MIN_PASSWORD : 12,
            maxPasswordLength: MAX_PASSWORD,
            resetPasswordTokenExpiresIn: 3600,
            revokeSessionsOnPasswordReset: true,
            // A new password ends every session; provider tokens go with them, since
            // offline_access refresh tokens outlive the sessions they came from.
            onPasswordReset: async ({ user }: { user: { id: string } }) =>
                revokeAfterReset(() => revokeProviderTokens(user.id)),
            ...(config.registration
                ? {
                      sendResetPassword: async ({
                          user,
                          token
                      }: {
                          user: { email: string }
                          token: string
                      }) =>
                          deliver({
                              kind: 'reset',
                              email: normaliseAccountEmail(user.email),
                              url: loginLink('/reset-password', token)
                          })
                  }
                : {})
        },
        ...(config.registration
            ? {
                  emailVerification: {
                      // Sent explicitly after sign-up so a delivery failure is reported.
                      sendOnSignUp: false,
                      // Confirming never signs in: the password must be typed, so a link
                      // from someone else's registration attempt cannot hand over a session.
                      autoSignInAfterVerification: false,
                      expiresIn: 3600,
                      sendVerificationEmail: async ({
                          user,
                          token
                      }: {
                          user: { email: string }
                          token: string
                      }) => {
                          const email = normaliseAccountEmail(user.email)
                          await deliver({
                              kind: 'verify',
                              email,
                              url: loginLink('/confirm', token),
                              code: await newConfirmationCode(email)
                          })
                      }
                  }
              }
            : {}),
        user: { modelName: 'haw_user', deleteUser: { enabled: true } },
        account: { modelName: 'haw_account' },
        verification: { modelName: 'haw_verification' },
        session: {
            modelName: 'haw_session',
            expiresIn: 60 * 60 * 24 * 30,
            updateAge: 60 * 60 * 24,
            // Accounts are passwordless, so better-auth's default 24h "fresh session"
            // requirement would block deletion for most users. Any valid session
            // may delete its own account (a deliberate product decision).
            freshAge: 0,
            cookieCache: { enabled: false }
        },
        rateLimit: {
            enabled: false,
            storage: 'database',
            modelName: 'haw_rate_limit',
            window: 60,
            max: 20
        },
        advanced: {
            cookiePrefix: 'hawconnect',
            useSecureCookies: new URL(baseURL).protocol === 'https:',
            trustedProxyHeaders: false
        },
        databaseHooks: {
            user: {
                create: {
                    before: async (user) => ({
                        data: {
                            ...user,
                            email: normaliseAccountEmail(user.email)
                        }
                    })
                },
                update: {
                    before: async (user) =>
                        user.email
                            ? {
                                  data: {
                                      ...user,
                                      email: normaliseAccountEmail(user.email)
                                  }
                              }
                            : undefined
                }
            }
        },
        plugins: [
            bearer(),
            // Only the server-side calls are used (create a code, check a code);
            // the add-on's HTTP routes sit under /api/auth, which is never public.
            ...(config.registration
                ? [
                      emailOTP({
                          otpLength: 6,
                          expiresIn: 3600,
                          allowedAttempts: CODE_ATTEMPTS,
                          storeOTP: 'hashed',
                          disableSignUp: true,
                          sendVerificationOnSignUp: false,
                          overrideDefaultEmailVerification: false,
                          // Codes go out inside the confirmation mail above, never on their own.
                          sendVerificationOTP: async () => {
                              throw new Error('MailUnavailable')
                          }
                      })
                  ]
                : []),
            ...(config.registration && config.loginOrigin
                ? oidcPlugins({ loginOrigin: config.loginOrigin })
                : []),
            ...(config.signInLink
                ? [
                      magicLink({
                          expiresIn: 600,
                          storeToken: 'hashed',
                          sendMagicLink: async ({ email, token }) =>
                              deliver({
                                  kind: 'link',
                                  email: normaliseAccountEmail(email),
                                  url: landing('/auth-confirm', { token })
                              })
                      })
                  ]
                : [])
        ]
    })
    async function limited(
        key: string,
        max: number,
        windowMs = 60000
    ): Promise<boolean> {
        const digest = createHash('sha256').update(key).digest('hex')
        const now = Date.now()
        const result = await config.pool.query(
            `INSERT INTO haw_rate_limit (id, key, count, "lastRequest") VALUES ($1,$2,1,$3)
            ON CONFLICT (key) DO UPDATE SET count = CASE WHEN haw_rate_limit."lastRequest" < $3 - $4::bigint THEN 1 ELSE haw_rate_limit.count + 1 END,
            "lastRequest" = CASE WHEN haw_rate_limit."lastRequest" < $3 - $4::bigint THEN $3 ELSE haw_rate_limit."lastRequest" END RETURNING count`,
            [crypto.randomUUID(), `account:${digest}`, now, windowMs]
        )
        return Number(result.rows[0].count) > max
    }
    const actions = createAccountActions({
        auth,
        pool: config.pool,
        baseURL,
        loginOrigin: config.loginOrigin,
        registration: config.registration === true,
        send: config.send,
        limited
    })
    // The HAWConnect app signs in at the login site; the API is its confidential client.
    const oidc =
        config.registration && config.loginOrigin
            ? createOidcAppClient({
                  auth,
                  secret: config.secret,
                  apiOrigin: config.baseURL,
                  loginOrigin: config.loginOrigin,
                  webOrigin,
                  clientSecret: config.appClientSecret
              })
            : null
    /** Deletes every access and refresh token the provider issued to this person. */
    async function revokeProviderTokens(userId: string) {
        if (!config.registration || !config.loginOrigin) return
        const { adapter } = await auth.$context
        const where = [{ field: 'userId', value: userId }]
        // Access tokens first: they may reference a refresh token.
        await adapter.deleteMany({ model: 'oauthAccessToken', where })
        await adapter.deleteMany({ model: 'oauthRefreshToken', where })
    }
    async function bodyOf(request: Request): Promise<Record<string, unknown>> {
        if (
            !request.headers.get('content-type')?.startsWith('application/json')
        )
            throw new Error('InvalidInput')
        const reader = request.body?.getReader()
        if (!reader) throw new Error('InvalidInput')
        let size = 0
        let text = ''
        const decoder = new TextDecoder()
        while (true) {
            const { value, done } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > 4096) {
                await reader.cancel()
                throw new Error('InvalidInput')
            }
            text += decoder.decode(value, { stream: true })
        }
        const value = JSON.parse(text + decoder.decode())
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('InvalidInput')
        return value
    }
    async function session(headers: Headers) {
        const value = await auth.api.getSession({
            headers,
            query: { disableRefresh: true }
        })
        if (!value) return null
        try {
            normaliseAccountEmail(value.user.email)
        } catch {
            return null
        }
        return value
    }
    async function handler(request: Request): Promise<Response> {
        const pathname = new URL(request.url).pathname
        const path = pathname.split('/').at(-1)
        const route = pathname.startsWith('/api/accounts/')
            ? pathname.slice('/api/accounts/'.length)
            : ''
        // Browser navigations (to and back from the login site): GET only, checked by
        // the signed state cookie rather than by Origin.
        if (route === 'oidc/start' || route === 'oidc/callback') {
            if (!oidc) return json({ error: 'NotFound' }, 404)
            if (request.method !== 'GET')
                return json({ error: 'MethodNotAllowed' }, 405)
            try {
                const ip =
                    request.headers.get('x-hawconnect-client-ip') ?? 'unknown'
                if (await limited(`oidc-get:${ip}`, 30))
                    return json({ error: 'TooManyRequests' }, 429)
            } catch {
                return json({ error: 'AccountUnavailable' }, 503)
            }
            return route === 'oidc/start'
                ? oidc.start(request)
                : await oidc.callback(request)
        }
        if (path === 'password' && !config.passwordLogin)
            return json({ error: 'NotFound' }, 404)
        if (path === 'request-link' && !config.signInLink)
            return json({ error: 'NotFound' }, 404)
        if (
            !config.registration &&
            [
                'register',
                'sign-in',
                'resend-verification',
                'forgot-password',
                'reset-password'
            ].includes(path ?? '')
        )
            return json({ error: 'NotFound' }, 404)
        const native = request.headers.get('x-hawconnect-client') === 'native'
        const origin = request.headers.get('origin')
        if (
            origin &&
            origin !== webOrigin &&
            !(native && origin === 'hawconnect://')
        )
            return json({ error: 'OriginNotAllowed' }, 403)
        if (request.method === 'GET' && path === 'session') {
            try {
                const response = await auth.handler(
                    new Request(new URL('/api/auth/get-session', baseURL), {
                        headers: request.headers
                    })
                )
                if (!response.ok)
                    return json({ error: 'AccountUnavailable' }, 503)
                const value = (await response.json()) as {
                    user?: { id: string; email: string }
                    session?: { expiresAt: string }
                } | null
                if (!value?.user || !value.session)
                    return json({ error: 'SignInRequired' }, 401)
                normaliseAccountEmail(value.user.email)
                const output = json({
                    user: { id: value.user.id, email: value.user.email },
                    expiresAt: value.session.expiresAt
                })
                for (const cookie of response.headers.getSetCookie())
                    output.headers.append('Set-Cookie', cookie)
                return output
            } catch {
                return json({ error: 'AccountUnavailable' }, 503)
            }
        }
        if (request.method !== 'POST')
            return json({ error: 'MethodNotAllowed' }, 405)
        if (!origin) return json({ error: 'OriginRequired' }, 403)
        if (
            ![
                'request-link',
                'password',
                'register',
                'sign-in',
                'resend-verification',
                'forgot-password',
                'reset-password',
                'confirm',
                'sign-out',
                'revoke-all',
                'delete-account'
            ].includes(path ?? '') &&
            !(oidc && route === 'oidc/exchange')
        )
            return json({ error: 'NotFound' }, 404)
        try {
            const body = await bodyOf(request)
            const ip =
                request.headers.get('x-hawconnect-client-ip') ?? 'unknown'
            if (await limited(`ip:${ip}`, 20))
                return json({ error: 'TooManyRequests' }, 429)
            const emailOf = () =>
                normaliseAccountEmail(
                    typeof body.email === 'string' ? body.email : ''
                )
            const password =
                typeof body.password === 'string' ? body.password : ''
            const validPassword = (min: number) =>
                password.length >= min && password.length <= MAX_PASSWORD
            const status: Record<ActionCode, number> = {
                InvalidAccountEmail: 400,
                InvalidPassword: 400,
                InvalidCredentials: 401,
                EmailNotVerified: 403,
                TooManyRequests: 429,
                MailUnavailable: 503,
                InvalidLink: 400,
                InvalidCode: 400,
                AccountUnavailable: 503
            }
            const failure = (code: ActionCode) =>
                json({ error: code }, status[code])
            if (route === 'oidc/exchange' && oidc) {
                if (!native) return json({ error: 'NativeClientRequired' }, 403)
                const result = await oidc.exchange(body)
                return result.ok ? json(result.value) : failure(result.code)
            }
            if (path === 'password') {
                let email: string
                try {
                    email = emailOf()
                } catch {
                    return json({ error: 'InvalidCredentials' }, 401)
                }
                if (!validPassword(12))
                    return json({ error: 'InvalidCredentials' }, 401)
                if (await limited(`password:${email}`, 5))
                    return json({ error: 'TooManyRequests' }, 429)
                try {
                    const response = await auth.handler(
                        new Request(
                            new URL('/api/auth/sign-in/email', baseURL),
                            {
                                method: 'POST',
                                headers: request.headers,
                                body: JSON.stringify({
                                    email,
                                    password
                                })
                            }
                        )
                    )
                    if (!response.ok)
                        return json({ error: 'InvalidCredentials' }, 401)
                    const value = (await response.json()) as {
                        token?: string
                        user?: {
                            id: string
                            email: string
                            emailVerified: boolean
                        }
                    }
                    if (!value.token || !value.user?.emailVerified)
                        return json({ error: 'InvalidCredentials' }, 401)
                    const output = json({
                        user: { id: value.user.id, email: value.user.email },
                        ...(native ? { token: value.token } : {})
                    })
                    return output
                } catch {
                    return json({ error: 'InvalidCredentials' }, 401)
                }
            }
            if (path === 'sign-in') {
                const result = await actions.signIn(
                    typeof body.email === 'string' ? body.email : '',
                    password,
                    request.headers
                )
                if (!result.ok) return failure(result.code)
                const output = json({
                    user: result.value.user,
                    ...(native ? { token: result.value.token } : {})
                })
                for (const cookie of result.value.setCookie)
                    output.headers.append('Set-Cookie', cookie)
                return output
            }
            if (path === 'register') {
                const result = await actions.register(
                    typeof body.email === 'string' ? body.email : '',
                    password
                )
                return result.ok ? json(result.value) : failure(result.code)
            }
            if (path === 'resend-verification' || path === 'forgot-password') {
                const email = typeof body.email === 'string' ? body.email : ''
                const result =
                    path === 'forgot-password'
                        ? await actions.forgotPassword(email)
                        : await actions.resendVerification(email)
                return result.ok ? json(result.value) : failure(result.code)
            }
            if (path === 'reset-password') {
                const result = await actions.resetPassword(
                    typeof body.token === 'string' ? body.token : '',
                    password
                )
                return result.ok ? json(result.value) : failure(result.code)
            }
            if (path === 'request-link') {
                let email: string
                try {
                    email = normaliseAccountEmail(
                        typeof body.email === 'string' ? body.email : ''
                    )
                } catch {
                    return json({ error: 'InvalidAccountEmail' }, 400)
                }
                if (!config.send) return json({ error: 'MailUnavailable' }, 503)
                if (await limited(`email:${email}`, 3))
                    return json({ error: 'TooManyRequests' }, 429)
                try {
                    await auth.api.signInMagicLink({
                        body: { email },
                        headers: request.headers
                    })
                    return json({ status: 'sent' })
                } catch {
                    return json({ error: 'MailUnavailable' }, 503)
                }
            }
            if (path === 'confirm') {
                if (
                    typeof body.token !== 'string' ||
                    body.token.length < 16 ||
                    body.token.length > 512
                )
                    return json({ error: 'InvalidLink' }, 400)
                if (body.kind === 'verify') {
                    const result = await actions.verifyEmail(body.token)
                    return result.ok ? json(result.value) : failure(result.code)
                }
                if (!config.signInLink)
                    return json({ error: 'InvalidLink' }, 400)
                const internal = new URL('/api/auth/magic-link/verify', baseURL)
                internal.searchParams.set('token', body.token)
                const response = await auth.handler(
                    new Request(internal, { headers: request.headers })
                )
                if (!response.ok) return json({ error: 'InvalidLink' }, 400)
                const data = (await response.json()) as {
                    user?: { id: string; email: string }
                    token?: string
                }
                if (!data.user) return json({ error: 'InvalidLink' }, 400)
                const output = json({
                    user: { id: data.user.id, email: data.user.email },
                    ...(native ? { token: data.token } : {})
                })
                for (const cookie of response.headers.getSetCookie())
                    output.headers.append('Set-Cookie', cookie)
                return output
            }
            const authenticated = await session(request.headers)
            if (!authenticated) return json({ error: 'SignInRequired' }, 401)
            const expected = request.headers.get('x-hawconnect-account')
            if (expected && expected !== authenticated.user.id)
                return json({ error: 'AccountChanged' }, 409)
            const endpoint =
                path === 'sign-out'
                    ? 'sign-out'
                    : path === 'delete-account'
                      ? 'delete-user'
                      : 'revoke-sessions'
            const response = await auth.handler(
                new Request(new URL(`/api/auth/${endpoint}`, baseURL), {
                    method: 'POST',
                    headers: request.headers,
                    body: '{}'
                })
            )
            // "Sign out all devices" and account deletion end every provider token too:
            // ending sessions alone leaves offline_access refresh tokens alive.
            if (
                response.ok &&
                (path === 'revoke-all' || path === 'delete-account')
            )
                await revokeProviderTokens(authenticated.user.id)
            // The web app also ends the login-site session through this address.
            if (path !== 'sign-out' || native || !oidc || !response.ok)
                return response
            const value = (await response.json()) as Record<string, unknown>
            const output = json(
                {
                    ...value,
                    endSessionUrl: oidc.endSessionUrl(authenticated.user.id)
                },
                response.status
            )
            for (const cookie of response.headers.getSetCookie())
                output.headers.append('Set-Cookie', cookie)
            return output
        } catch {
            return json({ error: 'AccountUnavailable' }, 503)
        }
    }
    return { auth, handler, session, actions, limited }
}
export type AccountAuthService = ReturnType<typeof createAccountAuth>

/** Bind a browser request to the account the client believes is active; never select ownership from this header. */
export async function getAccountOwner(
    service: AccountAuthService,
    headers: Headers
): Promise<string | undefined> {
    const expected = headers.get('x-hawconnect-account')
    if (!expected) return undefined
    const session = await service.session(headers)
    return session?.user.id === expected ? session.user.id : undefined
}
