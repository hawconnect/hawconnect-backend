import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Router } from 'express'
import type { PhotoStorage } from './photo-storage'

const NAME = /^[0-9a-f-]{36}\.(jpg|webp)$/
const nameOf = (key: string) => {
    const name = key.startsWith('marketplace/') ? key.slice(12) : ''
    if (!NAME.test(name)) throw Error('InvalidKey')
    return name
}

export interface LocalPhotoStorage extends PhotoStorage {
    /** File bytes when the signature matches and has not expired; otherwise null. */
    read(
        name: string,
        expires: string,
        signature: string
    ): Promise<{ data: Buffer; contentType: string } | null>
}

/**
 * DEVELOPMENT ONLY stand-in for the private R2 bucket: photos live in a local folder and are
 * served through short-lived HMAC-signed URLs. Never enabled when NODE_ENV is "production".
 */
export function createLocalPhotoStorage(config: {
    dir: string
    baseURL: string
    secret: string
    now?: () => number
}): LocalPhotoStorage {
    const now = config.now ?? Date.now
    const sign = (name: string, expires: string) =>
        createHmac('sha256', config.secret)
            .update(`${name}.${expires}`)
            .digest('hex')
    return {
        async put(key, data) {
            const name = nameOf(key)
            await mkdir(config.dir, { recursive: true })
            await writeFile(join(config.dir, name), data)
        },
        async signedUrl(key, seconds = 3600) {
            const name = nameOf(key)
            const expires = String(Math.floor(now() / 1000) + seconds)
            const url = new URL(
                `/api/marketplace/dev-photos/${name}`,
                config.baseURL
            )
            url.searchParams.set('exp', expires)
            url.searchParams.set('sig', sign(name, expires))
            return url.toString()
        },
        async remove(keys) {
            for (const key of keys)
                await rm(join(config.dir, nameOf(key)), { force: true })
        },
        async read(name, expires, signature) {
            if (!NAME.test(name) || !/^\d{1,12}$/.test(expires)) return null
            const expected = Buffer.from(sign(name, expires))
            const given = Buffer.from(signature)
            if (
                given.length !== expected.length ||
                !timingSafeEqual(given, expected) ||
                Number(expires) * 1000 < now()
            )
                return null
            try {
                return {
                    data: await readFile(join(config.dir, name)),
                    contentType: name.endsWith('.jpg')
                        ? 'image/jpeg'
                        : 'image/webp'
                }
            } catch {
                return null
            }
        }
    }
}

/** Serves local development photos; mounted only when the local stand-in is active. */
export function createLocalPhotoRouter(storage: LocalPhotoStorage) {
    const router = Router()
    router.get('/:name', async (req, res) => {
        const photo = await storage.read(
            String(req.params.name),
            String(req.query.exp ?? ''),
            String(req.query.sig ?? '')
        )
        if (!photo) {
            res.status(404).json({ error: 'NotFound' })
            return
        }
        res.set('Cache-Control', 'private, no-store')
        res.type(photo.contentType).send(photo.data)
    })
    return router
}

/** The local folder to use, or null. Refuses to run in production. */
export function localPhotoDir(
    env: Record<string, string | undefined> = process.env
): string | null {
    const dir = env.HAWCONNECT_MARKETPLACE_LOCAL_PHOTOS_DIR?.trim()
    return dir && env.NODE_ENV !== 'production' ? dir : null
}
