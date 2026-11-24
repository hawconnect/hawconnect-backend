import type { Express } from 'express'

/**
 * Rate limits are keyed on `req.ip`. Behind Coolify's reverse proxy every
 * request otherwise appears to come from the proxy, so all users would share
 * one bucket. Trust exactly `HAWCONNECT_TRUSTED_PROXY_HOPS` proxies (default 1);
 * never `true`, which would let clients spoof X-Forwarded-For.
 * Set it to 0 when the backend is reachable directly without a proxy.
 */
export function configureTrustProxy(
    app: Express,
    value: string | undefined
): void {
    const raw = value?.trim() || '1'
    if (!/^\d+$/.test(raw))
        throw new Error('HAWCONNECT_TRUSTED_PROXY_HOPS must be an integer >= 0')
    app.set('trust proxy', Number(raw))
}
