import type { RequestHandler } from 'express'

/**
 * Baseline headers for every response. The login host adds its own stricter
 * CSP on top (src/login/security.ts). HSTS only over HTTPS, so local HTTP
 * development is never pinned; behind the proxy `req.secure` relies on the
 * trust-proxy setting.
 */
export function securityHeaders(): RequestHandler {
    return (req, res, next) => {
        res.set({
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'X-Frame-Options': 'DENY'
        })
        if (req.secure)
            res.set(
                'Strict-Transport-Security',
                'max-age=31536000; includeSubDomains'
            )
        next()
    }
}
