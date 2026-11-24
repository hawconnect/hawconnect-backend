import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { Server } from 'node:http'
import express from 'express'
import { securityHeaders } from '../security-headers'

let server: Server
let base: string

beforeAll(async () => {
    const app = express()
    app.set('trust proxy', 1)
    app.use(securityHeaders())
    app.get('/x', (_req, res) => {
        res.json({ ok: true })
    })
    await new Promise<void>((resolve) => {
        server = app.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address == null || typeof address === 'string') throw Error('NoPort')
    base = `http://127.0.0.1:${address.port}`
})

afterAll(() => {
    server?.close()
})

test('every response gets nosniff, a referrer policy and frame blocking', async () => {
    const response = await fetch(`${base}/x`)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe(
        'strict-origin-when-cross-origin'
    )
    expect(response.headers.get('x-frame-options')).toBe('DENY')
})

test('HSTS is sent only over HTTPS', async () => {
    const plain = await fetch(`${base}/x`)
    expect(plain.headers.get('strict-transport-security')).toBeNull()

    const secure = await fetch(`${base}/x`, {
        headers: { 'X-Forwarded-Proto': 'https' }
    })
    expect(secure.headers.get('strict-transport-security')).toBe(
        'max-age=31536000; includeSubDomains'
    )
})
