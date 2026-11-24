import { afterAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalPhotoStorage, localPhotoDir } from '../local-photo-storage'

const dir = await mkdtemp(join(tmpdir(), 'hc-local-photos-'))
afterAll(() => rm(dir, { recursive: true, force: true }))
let clock = 1_800_000_000_000
const storage = createLocalPhotoStorage({
    dir,
    baseURL: 'http://localhost:4000',
    secret: 'local-photo-secret-with-thirty-two-chars',
    now: () => clock
})
const key = 'marketplace/123e4567-e89b-12d3-a456-426614174000.jpg'
const parts = (url: string) => {
    const u = new URL(url)
    return {
        name: u.pathname.split('/').at(-1) as string,
        exp: u.searchParams.get('exp') as string,
        sig: u.searchParams.get('sig') as string
    }
}

test('serves a stored photo only through an unexpired, untampered signed URL', async () => {
    await storage.put(key, Buffer.from('jpeg-bytes'), 'image/jpeg')
    const url = await storage.signedUrl(key, 60)
    expect(
        url.startsWith('http://localhost:4000/api/marketplace/dev-photos/')
    ).toBe(true)
    const { name, exp, sig } = parts(url)
    const photo = await storage.read(name, exp, sig)
    expect(photo?.data.toString()).toBe('jpeg-bytes')
    expect(photo?.contentType).toBe('image/jpeg')

    expect(
        await storage.read(
            name,
            exp,
            `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`
        )
    ).toBeNull()
    expect(await storage.read(name, String(Number(exp) + 600), sig)).toBeNull()
    expect(await storage.read('../../etc/passwd', exp, sig)).toBeNull()
    clock += 61_000
    expect(await storage.read(name, exp, sig)).toBeNull()
})

test('removes photos, treats missing ones as gone, and rejects foreign keys', async () => {
    await storage.put(key, Buffer.from('x'), 'image/jpeg')
    await storage.remove([key])
    await storage.remove([key])
    const { name, exp, sig } = parts(await storage.signedUrl(key))
    expect(await storage.read(name, exp, sig)).toBeNull()
    expect(
        storage.put('other/file.jpg', Buffer.from('x'), 'image/jpeg')
    ).rejects.toThrow('InvalidKey')
    expect(storage.remove(['marketplace/../x.jpg'])).rejects.toThrow(
        'InvalidKey'
    )
})

test('is never used in production', () => {
    expect(
        localPhotoDir({ HAWCONNECT_MARKETPLACE_LOCAL_PHOTOS_DIR: '/tmp/p' })
    ).toBe('/tmp/p')
    expect(
        localPhotoDir({
            HAWCONNECT_MARKETPLACE_LOCAL_PHOTOS_DIR: '/tmp/p',
            NODE_ENV: 'production'
        })
    ).toBeNull()
    expect(localPhotoDir({})).toBeNull()
})
