import { makeSignature } from 'better-auth/crypto'
import type { AccountAuthService } from './account-auth'

type Auth = AccountAuthService['auth']

const attributesOf = (attributes: Record<string, unknown>, maxAge: number) =>
    [
        `Max-Age=${maxAge}`,
        `Path=${typeof attributes.path === 'string' ? attributes.path : '/'}`,
        ...(typeof attributes.domain === 'string'
            ? [`Domain=${attributes.domain}`]
            : []),
        ...(attributes.httpOnly !== false ? ['HttpOnly'] : []),
        ...(attributes.secure ? ['Secure'] : []),
        `SameSite=${
            typeof attributes.sameSite === 'string'
                ? attributes.sameSite.charAt(0).toUpperCase() +
                  attributes.sameSite.slice(1).toLowerCase()
                : 'Lax'
        }`
    ].join('; ')

/**
 * Starts the same kind of session as today's sign-in for a person the login site
 * already authenticated: a `haw_session` row, its signed session cookie (accepted by
 * `GET /api/accounts/session`) and its raw token (accepted as `Authorization: Bearer`).
 */
export async function createAppSession(
    auth: Auth,
    userId: string
): Promise<{ token: string; setCookie: string[] }> {
    const context = await auth.$context
    const session = await context.internalAdapter.createSession(userId)
    if (!session?.token) throw new Error('SessionUnavailable')
    const { name, attributes } = context.authCookies.sessionToken
    const value = encodeURIComponent(
        `${session.token}.${await makeSignature(session.token, context.secret)}`
    )
    return {
        token: session.token,
        setCookie: [
            `${name}=${value}; ${attributesOf(
                attributes as Record<string, unknown>,
                context.sessionConfig.expiresIn
            )}`
        ]
    }
}
