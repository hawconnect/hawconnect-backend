import { randomUUID } from 'node:crypto'
import express, { type Request, type Response, type Router } from 'express'
import type { Pool } from 'pg'
import { processPhoto } from './photo-process'
import { newPhotoKey, type PhotoStorage } from './photo-storage'

export const MAX_UNATTACHED_PHOTOS = 15

export interface MarketplacePhotoDeps {
    owner(req: Request): Promise<string | undefined>
    storage: PhotoStorage
    pool: Pool
    blocked(userId: string): Promise<boolean>
    rulesAccepted(userId: string): Promise<boolean>
}

const fail = (res: Response, status: number, error: string) => {
    res.set('Cache-Control', 'no-store')
    res.status(status).json({ error })
}

export function createMarketplacePhotoRouter(
    deps: MarketplacePhotoDeps
): Router {
    const router = express.Router()
    router.post('/', async (req, res, next) => {
        try {
            const userId = await deps.owner(req)
            if (!userId) return fail(res, 401, 'SignInRequired')
            if (await deps.blocked(userId)) return fail(res, 403, 'Blocked')
            if (!(await deps.rulesAccepted(userId)))
                return fail(res, 403, 'RulesRequired')
            res.locals.photoUserId = userId
            next()
        } catch {
            fail(res, 503, 'PhotoUnavailable')
        }
    })
    router.post(
        '/',
        express.raw({
            type: ['image/jpeg', 'image/png', 'image/webp'],
            limit: '5mb'
        })
    )
    router.post('/', async (req, res) => {
        try {
            const userId = res.locals.photoUserId as string
            if (!Buffer.isBuffer(req.body) || req.body.length === 0)
                return fail(res, 415, 'InvalidPhoto')
            const count = await deps.pool.query(
                'SELECT count(*)::int AS count FROM haw_market_photo WHERE owner_id = $1 AND post_id IS NULL',
                [userId]
            )
            if (Number(count.rows[0]?.count ?? 0) >= MAX_UNATTACHED_PHOTOS)
                return fail(res, 429, 'PhotoLimit')
            let processed: Awaited<ReturnType<typeof processPhoto>>
            try {
                processed = await processPhoto(req.body)
            } catch (e) {
                return e instanceof Error && e.message === 'PhotoTooLarge'
                    ? fail(res, 413, 'PhotoTooLarge')
                    : fail(res, 415, 'InvalidPhoto')
            }
            const id = randomUUID()
            const key = newPhotoKey(processed.contentType)
            try {
                await deps.storage.put(
                    key,
                    processed.data,
                    processed.contentType
                )
            } catch {
                return fail(res, 503, 'PhotoUnavailable')
            }
            try {
                await deps.pool.query(
                    'INSERT INTO haw_market_photo (id, owner_id, object_key) VALUES ($1, $2, $3)',
                    [id, userId, key]
                )
            } catch {
                await deps.storage.remove([key]).catch(() => {})
                return fail(res, 503, 'PhotoUnavailable')
            }
            res.set('Cache-Control', 'no-store')
            res.json({ id })
        } catch {
            fail(res, 503, 'PhotoUnavailable')
        }
    })
    router.use(
        (
            err: { type?: string },
            _req: Request,
            res: Response,
            _next: unknown
        ) => {
            if (err?.type === 'entity.too.large')
                return fail(res, 413, 'PhotoTooLarge')
            fail(res, 400, 'InvalidPhoto')
        }
    )
    return router
}
