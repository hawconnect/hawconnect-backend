import { createHmac, timingSafeEqual } from 'node:crypto'

/** How long the API's sign-out ticket lets the login site end its session without asking. */
export const LOGOUT_TICKET_SECONDS = 60

const sign = (secret: string, payload: string) =>
    createHmac('sha256', secret)
        .update(`hawconnect.logout:${payload}`)
        .digest('base64url')

/**
 * The one-click sign-out ticket the API hands the web app with its end-session
 * address: `base64url({u, exp}) + '.' + HMAC-SHA256(accountSecret, 'hawconnect.logout:' + payload)`.
 * It only lets the login site end the session of the same person, so the app
 * never has to keep an ID token for `id_token_hint`.
 */
export function createLogoutTicket(
    secret: string,
    userId: string,
    now = Date.now()
) {
    const payload = Buffer.from(
        JSON.stringify({
            u: userId,
            exp: Math.floor(now / 1000) + LOGOUT_TICKET_SECONDS
        })
    ).toString('base64url')
    return `${payload}.${sign(secret, payload)}`
}

/** The user the ticket names, or null for a forged, malformed or expired ticket. */
export function readLogoutTicket(
    secret: string,
    ticket: string,
    now = Date.now()
): string | null {
    if (!ticket || ticket.length > 1024) return null
    const [payload, signature, extra] = ticket.split('.')
    if (!payload || !signature || extra !== undefined) return null
    const expected = Buffer.from(sign(secret, payload))
    const given = Buffer.from(signature)
    if (expected.length !== given.length || !timingSafeEqual(expected, given))
        return null
    try {
        const value = JSON.parse(
            Buffer.from(payload, 'base64url').toString()
        ) as { u?: unknown; exp?: unknown }
        if (
            typeof value.u !== 'string' ||
            !value.u ||
            typeof value.exp !== 'number' ||
            value.exp * 1000 <= now
        )
            return null
        return value.u
    } catch {
        return null
    }
}
