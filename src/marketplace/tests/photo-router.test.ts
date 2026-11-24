import { expect, test } from 'bun:test'
import express from 'express'
import type { Pool } from 'pg'
import sharp from 'sharp'
import { createMarketplacePhotoRouter } from '../photo-router'
import { readMarketplaceR2Config } from '../photo-storage'

type Deps = Parameters<typeof createMarketplacePhotoRouter>[0]

const jpeg = () =>
    sharp({
        create: {
            width: 32,
            height: 32,
            channels: 3,
            background: { r: 5, g: 50, b: 100 }
        }
    })
        .jpeg()
        .toBuffer()

async function setup(
    over: Partial<Deps> = {},
    unattached = 0,
    failInsert = false
) {
    const puts: { key: string; type: string; data: Buffer }[] = []
    const removes: string[][] = []
    const inserts: unknown[][] = []
    const pool = {
        query: async (sql: string, params: unknown[] = []) => {
            if (/count\(/i.test(sql)) return { rows: [{ count: unattached }] }
            if (failInsert) throw Error('db down')
            inserts.push(params)
            return { rows: [] }
        }
    } as unknown as Pool
    const deps: Deps = {
        owner: async () => 'user-1',
        blocked: async () => false,
        rulesAccepted: async () => true,
        pool,
        storage: {
            put: async (key, data, type) => {
                puts.push({ key, type, data })
            },
            signedUrl: async () => 'https://signed',
            remove: async (keys) => {
                removes.push(keys)
            }
        },
        ...over
    }
    const app = express()
    app.use('/photos', createMarketplacePhotoRouter(deps))
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', r))
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw Error('no server')
    const post = (body: BodyInit, type = 'image/jpeg') =>
        fetch(`http://127.0.0.1:${addr.port}/photos`, {
            method: 'POST',
            headers: { 'Content-Type': type },
            body
        })
    return { post, puts, inserts, removes, close: () => server.close() }
}

test('unauthenticated -> 401 SignInRequired', async () => {
    const t = await setup({ owner: async () => undefined })
    const res = await t.post(await jpeg())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'SignInRequired' })
    expect(res.headers.get('cache-control')).toBe('no-store')
    t.close()
})

test('blocked -> 403 Blocked', async () => {
    const t = await setup({ blocked: async () => true })
    const res = await t.post(await jpeg())
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Blocked' })
    t.close()
})

test('rules not accepted -> 403 RulesRequired', async () => {
    const t = await setup({ rulesAccepted: async () => false })
    const res = await t.post(await jpeg())
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'RulesRequired' })
    t.close()
})

test('15 unattached -> 429 PhotoLimit', async () => {
    const t = await setup({}, 15)
    const res = await t.post(await jpeg())
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'PhotoLimit' })
    t.close()
})

test('valid upload -> 200 id, stored privately', async () => {
    const t = await setup()
    const original = await jpeg()
    const res = await t.post(original)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string }
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(t.puts).toHaveLength(1)
    expect(t.puts[0]?.key).toMatch(/^marketplace\/[0-9a-f-]{36}\.(jpg|webp)$/)
    expect(t.inserts).toHaveLength(1)
    expect(t.inserts[0]?.[0]).toBe(body.id)
    expect(t.inserts[0]?.[2]).toBe(t.puts[0]?.key)
    expect(t.puts[0]?.data.equals(original)).toBe(false)
    expect(res.headers.get('cache-control')).toBe('no-store')
    t.close()
})

test('wrong content type -> 415 InvalidPhoto', async () => {
    const t = await setup()
    const res = await t.post('hello', 'text/plain')
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'InvalidPhoto' })
    t.close()
})

test('fake image bytes -> InvalidPhoto', async () => {
    const t = await setup()
    const res = await t.post('not really a jpeg')
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'InvalidPhoto' })
    t.close()
})

test('over 5 MB -> 413 PhotoTooLarge', async () => {
    const t = await setup()
    const res = await t.post(new Uint8Array(5 * 1024 * 1024 + 10))
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'PhotoTooLarge' })
    t.close()
})

test('storage failure -> 503 PhotoUnavailable', async () => {
    const t = await setup({
        storage: {
            put: async () => {
                throw Error('boom')
            },
            signedUrl: async () => '',
            remove: async () => {}
        }
    })
    const res = await t.post(await jpeg())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'PhotoUnavailable' })
    t.close()
})

test('readMarketplaceR2Config validates env', () => {
    expect(readMarketplaceR2Config({})).toBeNull()
    expect(
        readMarketplaceR2Config({
            HAWCONNECT_MARKETPLACE_R2_ACCOUNT_ID: 'a'.repeat(32),
            HAWCONNECT_MARKETPLACE_R2_ACCESS_KEY_ID: 'k',
            HAWCONNECT_MARKETPLACE_R2_SECRET_ACCESS_KEY: 's',
            HAWCONNECT_MARKETPLACE_R2_BUCKET: 'my-bucket'
        })
    ).toEqual({
        accountId: 'a'.repeat(32),
        accessKeyId: 'k',
        secretAccessKey: 's',
        bucket: 'my-bucket'
    })
})

test('unauthenticated upload is rejected before the body is read', async () => {
    let untouched = false
    const t = await setup({
        owner: async (req) => {
            untouched = !req.readableEnded && req.readableFlowing === null
            return undefined
        }
    })
    const res = await t.post(new Uint8Array(5 * 1024 * 1024))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'SignInRequired' })
    expect(untouched).toBe(true)
    t.close()
})

test('insert failure -> 503 and stored object is removed', async () => {
    const t = await setup({}, 0, true)
    const res = await t.post(await jpeg())
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'PhotoUnavailable' })
    expect(t.puts).toHaveLength(1)
    expect(t.removes).toEqual([[t.puts[0]?.key]])
    t.close()
})
