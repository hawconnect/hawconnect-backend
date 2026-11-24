import type { AccountAuthService } from '@/lib/account-auth'
import { createLogoutTicket } from '@/lib/logout-ticket'
import { redeemAuthorizationCode } from '@/lib/oidc-app-client'

export const CONSOLE_CLIENT_ID = 'hawconnect-console'

const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/

type Auth = AccountAuthService['auth']

export type ConsoleSignInResult =
    | { ok: true; user: { id: string; email: string; emailVerified: boolean } }
    | { ok: false }

/**
 * The dashboard signs in at account.hawconnect.de like the phone apps do: it
 * keeps state, nonce and PKCE verifier, and hands the code here. Only this
 * backend holds the dashboard's client secret.
 */
export function createConsoleSignIn(config: {
    /** The account service that runs the OpenID provider (account.hawconnect.de). */
    providerAuth: Auth
    loginOrigin: string
    consoleOrigin: string
    clientSecret: string
    /** Signs the one-click logout ticket the login site accepts. */
    accountSecret: string
}) {
    const loginOrigin = new URL(config.loginOrigin).origin
    const consoleOrigin = new URL(config.consoleOrigin).origin
    const redirectUri = `${consoleOrigin}/auth/callback`

    async function exchange(
        body: Record<string, unknown> | undefined
    ): Promise<ConsoleSignInResult> {
        const { code, codeVerifier, nonce } = body ?? {}
        if (
            body?.redirectUri !== redirectUri ||
            typeof code !== 'string' ||
            !code ||
            code.length > 512 ||
            typeof codeVerifier !== 'string' ||
            !VERIFIER.test(codeVerifier) ||
            typeof nonce !== 'string' ||
            !nonce ||
            nonce.length > 512
        )
            return { ok: false }
        const result = await redeemAuthorizationCode(
            {
                auth: config.providerAuth,
                loginOrigin,
                clientId: CONSOLE_CLIENT_ID,
                clientSecret: config.clientSecret
            },
            { code, verifier: codeVerifier, redirectUri, nonce }
        )
        if (!result.ok) {
            if (process.env.NODE_ENV !== 'test')
                console.warn(`Dashboard sign-in failed: ${result.why}`)
            return { ok: false }
        }
        const context = await config.providerAuth.$context
        const user = await context.internalAdapter.findUserById(result.userId)
        if (!user) return { ok: false }
        return {
            ok: true,
            user: {
                id: user.id,
                email: user.email,
                emailVerified: user.emailVerified === true
            }
        }
    }

    /** Signs the person out of account.hawconnect.de in one step, then back to the dashboard. */
    const endSessionUrl = (userId: string) =>
        `${loginOrigin}/api/auth/oauth2/end-session?${new URLSearchParams({
            client_id: CONSOLE_CLIENT_ID,
            post_logout_redirect_uri: `${consoleOrigin}/login`,
            ticket: createLogoutTicket(config.accountSecret, userId)
        })}`

    return { exchange, endSessionUrl }
}
