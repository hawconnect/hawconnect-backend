import { expect, test } from 'bun:test'
import express from 'express'
import { configureTrustProxy } from '../../lib/trust-proxy'

async function ipSeenBy(
    app: express.Express,
    forwardedFor?: string
): Promise<string> {
    app.get('/ip', (req, res) => {
        res.json({ ip: req.ip })
    })
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('No server')
    try {
        const response = await fetch(`http://127.0.0.1:${address.port}/ip`, {
            headers: forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}
        })
        return ((await response.json()) as { ip: string }).ip
    } finally {
        server.close()
    }
}

test('uses the client address forwarded by one reverse proxy by default', async () => {
    const app = express()
    configureTrustProxy(app, undefined)
    expect(await ipSeenBy(app, '203.0.113.7')).toBe('203.0.113.7')
})

test('ignores client-supplied addresses beyond the trusted hop count', async () => {
    const app = express()
    configureTrustProxy(app, undefined)
    // A client can prepend a fake address; only the proxy-appended one counts.
    expect(await ipSeenBy(app, '198.51.100.1, 203.0.113.7')).toBe('203.0.113.7')
})

test('can disable proxy trust for direct deployments', async () => {
    const app = express()
    configureTrustProxy(app, '0')
    expect(await ipSeenBy(app, '203.0.113.7')).toBe('127.0.0.1')
})

test('rejects unsafe or malformed hop counts', () => {
    expect(() => configureTrustProxy(express(), 'true')).toThrow()
    expect(() => configureTrustProxy(express(), '-1')).toThrow()
})
