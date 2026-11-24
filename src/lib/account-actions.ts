import type { Pool } from 'pg'
import { normaliseAccountEmail } from '@/utils/account-policy'
import type { AccountMail } from './account-auth'

export const MIN_PASSWORD = 8
export const MAX_PASSWORD = 128
const HOUR = 60 * 60 * 1000

export type ActionCode =
    | 'InvalidAccountEmail'
    | 'InvalidPassword'
    | 'InvalidCredentials'
    | 'EmailNotVerified'
    | 'TooManyRequests'
    | 'MailUnavailable'
    | 'InvalidLink'
    | 'InvalidCode'
    | 'AccountUnavailable'
export type ActionResult<T> =
    | { ok: true; value: T }
    | { ok: false; code: ActionCode }

export interface SignInValue {
    user: { id: string; email: string }
    token: string
    setCookie: string[]
    /** Only with an authorize query: where the provider sends the browser next. */
    redirect?: string
}

/** The better-auth surface the actions use; kept structural so tests and the login pages share it. */
interface ActionAuth {
    handler: (request: Request) => Promise<Response>
    api: {
        signUpEmail: (input: {
            body: { email: string; password: string; name: string }
        }) => Promise<unknown>
        sendVerificationEmail: (input: {
            body: { email: string }
        }) => Promise<unknown>
        requestPasswordReset: (input: {
            body: { email: string }
        }) => Promise<unknown>
        verifyEmailOTP: (input: {
            body: { email: string; otp: string }
        }) => Promise<unknown>
        getSession: (input: {
            headers: Headers
            query?: { disableRefresh?: boolean }
        }) => Promise<{
            session: { token: string }
            user: { id: string; email: string }
        } | null>
    }
    $context: Promise<{
        internalAdapter: {
            updatePassword: (userId: string, hash: string) => Promise<unknown>
        }
        password: { hash: (password: string) => Promise<string> }
    }>
}

export interface AccountActionsConfig {
    auth: ActionAuth
    pool: Pool
    baseURL: string
    loginOrigin?: string
    registration: boolean
    send?: (message: AccountMail) => Promise<void>
    limited: (key: string, max: number, windowMs?: number) => Promise<boolean>
}

const fail = (code: ActionCode): { ok: false; code: ActionCode } => ({
    ok: false,
    code
})
const sent = { ok: true as const, value: { status: 'sent' as const } }

/**
 * Account operations shared by the JSON routes and the login pages. They own
 * validation, per-address rate limits and mail sending; callers own Origin
 * checks, the per-IP limit and body parsing. Never throws for user errors, and
 * never logs emails, tokens or passwords.
 */
export function createAccountActions(config: AccountActionsConfig) {
    const { auth, pool, limited } = config
    const deliver = async (message: AccountMail) => {
        if (!config.send) throw new Error('MailUnavailable')
        await config.send(message)
    }
    const emailOf = (value: string) => {
        try {
            return normaliseAccountEmail(value)
        } catch {
            return null
        }
    }
    const validPassword = (password: string, min = MIN_PASSWORD) =>
        typeof password === 'string' &&
        password.length >= min &&
        password.length <= MAX_PASSWORD
    const validToken = (token: unknown): token is string =>
        typeof token === 'string' && token.length >= 16 && token.length <= 512
    /** A failing limiter store is an unavailable account service, not a user error. */
    const guarded = async <T>(
        run: () => Promise<ActionResult<T>>
    ): Promise<ActionResult<T>> => {
        try {
            return await run()
        } catch {
            return fail('AccountUnavailable')
        }
    }

    async function register(
        rawEmail: string,
        password: string,
        /** Shown nowhere publicly; '' when the caller does not ask for one. */
        rawName = ''
    ): Promise<ActionResult<{ status: 'sent' }>> {
        const name = rawName.trim().slice(0, 100)
        return guarded(async () => {
            if (!config.registration) return fail('AccountUnavailable')
            const email = emailOf(rawEmail)
            if (!email) return fail('InvalidAccountEmail')
            if (!validPassword(password)) return fail('InvalidPassword')
            if (!config.send) return fail('MailUnavailable')
            if (await limited(`register:${email}`, 3, HOUR))
                return fail('TooManyRequests')
            try {
                const existing = await pool.query(
                    'SELECT id, "emailVerified" FROM haw_user WHERE email = $1',
                    [email]
                )
                // Same answer in every case, so nobody can test which emails have an account.
                if (existing.rows[0]?.emailVerified)
                    await deliver({
                        kind: 'exists',
                        email,
                        url: new URL(
                            '/sign-in',
                            config.loginOrigin ?? config.baseURL
                        ).toString()
                    })
                else {
                    if (!existing.rowCount)
                        await auth.api.signUpEmail({
                            body: { email, password, name }
                        })
                    else {
                        // Unconfirmed account: the latest registration's password wins,
                        // so an earlier attempt by someone else cannot pre-set it.
                        const context = await auth.$context
                        await context.internalAdapter.updatePassword(
                            existing.rows[0].id,
                            await context.password.hash(password)
                        )
                        if (name)
                            await pool.query(
                                'UPDATE haw_user SET name = $2 WHERE id = $1',
                                [existing.rows[0].id, name]
                            )
                    }
                    await auth.api.sendVerificationEmail({ body: { email } })
                }
                return sent
            } catch {
                return fail('MailUnavailable')
            }
        })
    }

    /**
     * Signs in with email and password. With `oauthQuery` (the provider's signed
     * authorize query from the login page) the provider continues the flow in the
     * same request and `redirect` names where the browser goes next; a query whose
     * signature is invalid or expired gives `InvalidLink` and creates no session.
     */
    async function signIn(
        rawEmail: string,
        password: string,
        headers: Headers,
        oauthQuery?: string
    ): Promise<ActionResult<SignInValue>> {
        return guarded<SignInValue>(async () => {
            const email = emailOf(rawEmail)
            if (!email || !validPassword(password))
                return fail('InvalidCredentials')
            if (await limited(`sign-in:${email}`, 5, HOUR / 4))
                return fail('TooManyRequests')
            try {
                // Forward the caller's headers (Origin and fetch metadata
                // included) so better-auth's own origin check sees the browser's
                // request and the session row records its user agent and address.
                // The body is always JSON, and so is the answer (the provider
                // would otherwise redirect a browser form post).
                const forwarded = new Headers(headers)
                forwarded.set('content-type', 'application/json')
                forwarded.set('accept', 'application/json')
                forwarded.delete('content-length')
                const response = await auth.handler(
                    new Request(
                        new URL('/api/auth/sign-in/email', config.baseURL),
                        {
                            method: 'POST',
                            headers: forwarded,
                            body: JSON.stringify({
                                email,
                                password,
                                ...(oauthQuery
                                    ? { oauth_query: oauthQuery }
                                    : {})
                            })
                        }
                    )
                )
                if (oauthQuery && response.status === 400) {
                    const error = (await response.json()) as {
                        error?: string
                    }
                    if (error.error === 'invalid_signature')
                        return fail('InvalidLink')
                    return fail('InvalidCredentials')
                }
                // better-auth checks the password before it reports an unconfirmed
                // email; any other refusal (such as its origin check) is not that.
                if (response.status === 403) {
                    const error = (await response.json().catch(() => ({}))) as {
                        code?: string
                    }
                    return fail(
                        error.code === 'EMAIL_NOT_VERIFIED'
                            ? 'EmailNotVerified'
                            : 'InvalidCredentials'
                    )
                }
                if (!response.ok) return fail('InvalidCredentials')
                const setCookie = response.headers.getSetCookie()
                const value = (await response.json()) as {
                    token?: string
                    user?: {
                        id: string
                        email: string
                        emailVerified: boolean
                    }
                    redirect?: boolean
                    url?: string
                }
                if (oauthQuery && value.redirect && value.url) {
                    // The provider answered with the next step instead of the user.
                    const cookie = setCookie
                        .map((line) => line.split(';')[0])
                        .join('; ')
                    const session = await auth.api.getSession({
                        headers: new Headers({ cookie }),
                        query: { disableRefresh: true }
                    })
                    if (!session) return fail('InvalidCredentials')
                    return {
                        ok: true,
                        value: {
                            user: {
                                id: session.user.id,
                                email: session.user.email
                            },
                            token: session.session.token,
                            setCookie,
                            redirect: value.url
                        }
                    }
                }
                if (!value.token || !value.user?.emailVerified)
                    return fail('InvalidCredentials')
                return {
                    ok: true,
                    value: {
                        user: { id: value.user.id, email: value.user.email },
                        token: value.token,
                        setCookie
                    }
                }
            } catch {
                return fail('InvalidCredentials')
            }
        })
    }

    const mailAgain =
        (kind: 'resend-verification' | 'forgot-password') =>
        async (rawEmail: string): Promise<ActionResult<{ status: 'sent' }>> =>
            guarded(async () => {
                if (!config.registration) return fail('AccountUnavailable')
                const email = emailOf(rawEmail)
                if (!email) return fail('InvalidAccountEmail')
                if (!config.send) return fail('MailUnavailable')
                if (await limited(`${kind}:${email}`, 3, HOUR))
                    return fail('TooManyRequests')
                try {
                    if (kind === 'forgot-password')
                        await auth.api.requestPasswordReset({ body: { email } })
                    else
                        await auth.api.sendVerificationEmail({
                            body: { email }
                        })
                    return sent
                } catch {
                    return fail('MailUnavailable')
                }
            })

    async function resetPassword(
        token: string,
        password: string
    ): Promise<ActionResult<{ status: 'reset' }>> {
        return guarded(async () => {
            if (!config.registration) return fail('AccountUnavailable')
            if (!validToken(token)) return fail('InvalidLink')
            if (!validPassword(password)) return fail('InvalidPassword')
            const response = await auth.handler(
                new Request(
                    new URL('/api/auth/reset-password', config.baseURL),
                    {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ token, newPassword: password })
                    }
                )
            )
            if (!response.ok) return fail('InvalidLink')
            return { ok: true, value: { status: 'reset' } }
        })
    }

    async function verifyEmail(
        token: string
    ): Promise<ActionResult<{ status: 'verified' }>> {
        return guarded(async () => {
            if (!config.registration) return fail('InvalidLink')
            if (!validToken(token)) return fail('InvalidLink')
            const verify = new URL('/api/auth/verify-email', config.baseURL)
            verify.searchParams.set('token', token)
            const response = await auth.handler(new Request(verify))
            if (!response.ok) return fail('InvalidLink')
            return { ok: true, value: { status: 'verified' } }
        })
    }

    /** The 6-digit code from the confirmation mail; never signs in (like the link). */
    async function verifyEmailCode(
        rawEmail: string,
        code: string
    ): Promise<ActionResult<{ status: 'verified' }>> {
        return guarded(async () => {
            if (!config.registration) return fail('InvalidCode')
            const email = emailOf(rawEmail)
            if (!email || !/^\d{6}$/.test(code)) return fail('InvalidCode')
            // Bounds guessing across fresh codes too (each code allows 5 tries).
            if (await limited(`verify-code:${email}`, 15, HOUR))
                return fail('TooManyRequests')
            try {
                await auth.api.verifyEmailOTP({ body: { email, otp: code } })
                return { ok: true, value: { status: 'verified' } }
            } catch {
                return fail('InvalidCode')
            }
        })
    }

    return {
        register,
        verifyEmailCode,
        signIn,
        resendVerification: mailAgain('resend-verification'),
        forgotPassword: mailAgain('forgot-password'),
        resetPassword,
        verifyEmail
    }
}
export type AccountActions = ReturnType<typeof createAccountActions>
