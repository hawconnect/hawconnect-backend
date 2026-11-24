import type { IncomingHttpHeaders } from 'node:http'
import type { RequestHandler } from 'express'
import type { OidcClientConfig } from '@/lib/oidc-clients'

/** True when the request's `Host` header names the login origin's host. */
export function isLoginHost(headers: IncomingHttpHeaders, loginOrigin: string) {
    const host = headers.host
    if (!host) return false
    try {
        return (
            new URL(`http://${host}`).hostname === new URL(loginOrigin).hostname
        )
    } catch {
        return false
    }
}

/**
 * Where a login-site form may end up. Browsers apply `form-action` to the form
 * action and to every redirect that follows the post, so the list must cover
 * every hop of every form post: the login site itself, the registered return
 * addresses (sign-in), the registered post-logout addresses (sign-out) and,
 * since the API's callback sends the web app on, the web origin, which is
 * registered as a post-logout address.
 */
export function formTargetsOf(clients: OidcClientConfig[]) {
    const targets = new Set<string>()
    for (const client of clients)
        for (const uri of [
            ...client.redirectUris,
            ...client.postLogoutRedirectUris
        ]) {
            const url = new URL(uri)
            targets.add(
                url.protocol === 'https:' || url.protocol === 'http:'
                    ? url.origin
                    : url.protocol
            )
        }
    return [...targets].sort()
}

/** Headers for every response on the login host. */
export function securityHeaders(formTargets: string[]): RequestHandler {
    const csp = [
        "default-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        ["form-action 'self'", ...formTargets].join(' ')
    ].join('; ')
    return (_req, res, next) => {
        res.removeHeader('X-Powered-By')
        res.set({
            'Content-Security-Policy': csp,
            // same-origin, not no-referrer: under no-referrer browsers send
            // `Origin: null` on same-origin form posts, which the CSRF check refuses.
            'Referrer-Policy': 'same-origin',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Cache-Control': 'no-store'
        })
        next()
    }
}

/** Reads one cookie from the request without decoding any other. */
export function cookieOf(headers: IncomingHttpHeaders, name: string) {
    for (const part of (headers.cookie ?? '').split(';')) {
        const index = part.indexOf('=')
        if (index > 0 && part.slice(0, index).trim() === name)
            try {
                return decodeURIComponent(part.slice(index + 1).trim())
            } catch {
                return undefined
            }
    }
    return undefined
}
