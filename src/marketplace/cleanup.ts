import type { Pool } from 'pg'
import { type PhotoStorage, unconfirmedKeys } from './photo-storage'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const RETENTION_DAYS = 30

export interface MarketplaceCleanupDeps {
    pool: Pool
    storage: PhotoStorage
    now(): Date
}

const CHUNK_SIZE = 100
const MAX_CHUNKS = 20

export interface MarketplaceCleanupOptions {
    chunkSize?: number
    maxChunks?: number
}

/**
 * Walks due ids in id order, one chunk at a time with a keyset cursor, so a failing
 * chunk is skipped (retried next run) and later chunks still proceed.
 */
async function forEachChunk<T extends { id: string }>(
    fetch: (after: string, limit: number) => Promise<T[]>,
    handle: (rows: T[]) => Promise<void>,
    {
        chunkSize = CHUNK_SIZE,
        maxChunks = MAX_CHUNKS
    }: MarketplaceCleanupOptions
): Promise<void> {
    let after = '00000000-0000-0000-0000-000000000000'
    for (let i = 0; i < maxChunks; i++) {
        let rows: T[]
        try {
            rows = await fetch(after, chunkSize)
        } catch {
            console.error('Marketplace cleanup chunk query failed')
            return
        }
        if (!rows.length) return
        after = rows[rows.length - 1].id
        try {
            await handle(rows)
        } catch {
            console.error('Marketplace cleanup chunk failed')
        }
        if (rows.length < chunkSize) return
    }
}

/* $1 is the retention cutoff. Repeated in the DELETE so a post renewed after the select survives. */
const PURGE_DUE = `((status NOT IN ('active','reserved') AND expires_at < $1)
    OR (status IN ('removedByOwner','removedByModerator') AND updated_at < $1))`

async function deleteExpiredPosts(
    { pool }: MarketplaceCleanupDeps,
    now: Date,
    options: MarketplaceCleanupOptions
): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY)
    let deleted = 0
    await forEachChunk(
        async (after, limit) =>
            (
                await pool.query<{ id: string }>(
                    `SELECT id FROM haw_market_post
                     WHERE id > $2 AND ${PURGE_DUE}
                     ORDER BY id LIMIT $3`,
                    [cutoff, after, limit]
                )
            ).rows,
        async (rows) => {
            // Photo rows cascade; the delete trigger queues their keys for the R2 purge.
            const res = await pool.query(
                `DELETE FROM haw_market_post WHERE id = ANY($2) AND ${PURGE_DUE}`,
                [cutoff, rows.map((r) => r.id)]
            )
            deleted += res.rowCount ?? 0
        },
        options
    )
    return deleted
}

async function deleteUnattachedPhotos(
    { pool }: MarketplaceCleanupDeps,
    now: Date,
    options: MarketplaceCleanupOptions
): Promise<void> {
    const cutoff = new Date(now.getTime() - DAY)
    await forEachChunk(
        async (after, limit) =>
            (
                await pool.query<{ id: string }>(
                    `SELECT id FROM haw_market_photo
                     WHERE post_id IS NULL AND created_at < $1 AND id > $2
                     ORDER BY id LIMIT $3`,
                    [cutoff, after, limit]
                )
            ).rows,
        async (rows) => {
            await pool.query(
                'DELETE FROM haw_market_photo WHERE id = ANY($1) AND post_id IS NULL',
                [rows.map((r) => r.id)]
            )
        },
        options
    )
}

/**
 * Removes the objects from R2, then drops the purge-queue rows of exactly the keys R2 confirmed.
 * Returns the keys still queued. Never throws for storage failures.
 */
export async function purgePhotoObjects(
    pool: Pool,
    storage: PhotoStorage,
    keys: string[]
): Promise<string[]> {
    if (!keys.length) return []
    let failed: string[] = []
    try {
        await storage.remove(keys)
    } catch (error) {
        failed = unconfirmedKeys(keys, error)
    }
    const confirmed = keys.filter((k) => !failed.includes(k))
    if (confirmed.length)
        await pool.query(
            'DELETE FROM haw_market_photo_purge WHERE object_key = ANY($1)',
            [confirmed]
        )
    return failed
}

/**
 * Drains the purge queue oldest first with a keyset cursor, so keys that keep failing
 * stay queued without blocking newer ones, and one run touches each key at most once.
 */
async function drainPhotoPurge(
    { pool, storage }: MarketplaceCleanupDeps,
    {
        chunkSize = CHUNK_SIZE,
        maxChunks = MAX_CHUNKS
    }: MarketplaceCleanupOptions
): Promise<void> {
    // queued_at travels as text: a JS Date would cut microseconds and re-select the last row.
    let after: [string, string] = ['-infinity', '']
    for (let i = 0; i < maxChunks; i++) {
        const rows = (
            await pool.query<{ object_key: string; queued_at: string }>(
                `SELECT object_key, queued_at::text AS queued_at FROM haw_market_photo_purge
                 WHERE (queued_at, object_key) > ($1::timestamptz, $2::text)
                 ORDER BY queued_at, object_key LIMIT $3`,
                [after[0], after[1], chunkSize]
            )
        ).rows
        if (!rows.length) return
        const last = rows[rows.length - 1]
        after = [last.queued_at, last.object_key]
        const failed = await purgePhotoObjects(
            pool,
            storage,
            rows.map((r) => r.object_key)
        )
        if (failed.length) console.error('Marketplace photo purge chunk failed')
        if (rows.length < chunkSize) return
    }
}

/** Hourly expiry and data-retention pass; one failing rule never stops the others. */
export async function runMarketplaceCleanup(
    deps: MarketplaceCleanupDeps,
    options: MarketplaceCleanupOptions = {}
): Promise<{ expired: number; deleted: number }> {
    const { pool } = deps
    const now = deps.now()
    const result = { expired: 0, deleted: 0 }
    const rule = async (name: string, fn: () => Promise<void>) => {
        try {
            await fn()
        } catch {
            console.error(`Marketplace cleanup rule failed: ${name}`)
        }
    }
    const monthAgo = new Date(now.getTime() - RETENTION_DAYS * DAY)
    const yearAgo = new Date(now.getTime() - 365 * DAY)

    await rule('expire', async () => {
        const r = await pool.query(
            "UPDATE haw_market_post SET status = 'expired', updated_at = $1 WHERE status IN ('active','reserved') AND expires_at <= $1",
            [now]
        )
        result.expired = r.rowCount ?? 0
    })
    await rule('posts', async () => {
        result.deleted = await deleteExpiredPosts(deps, now, options)
    })
    await rule('photos', () => deleteUnattachedPhotos(deps, now, options))
    // After every rule that deletes photo rows, so their objects go in the same run.
    await rule('photo purge', () => drainPhotoPurge(deps, options))
    await rule('messages', async () => {
        await pool.query(
            'DELETE FROM haw_market_message WHERE created_at < $1',
            [monthAgo]
        )
    })
    await rule('reports', async () => {
        await pool.query(
            'DELETE FROM haw_market_report WHERE created_at < $1',
            [yearAgo]
        )
        await pool.query(
            'UPDATE haw_market_report SET snapshot = NULL WHERE post_id IS NULL AND snapshot IS NOT NULL'
        )
    })
    await rule('blocks', async () => {
        await pool.query(
            "UPDATE haw_market_block SET lifted_at = $1, email_hash = '' WHERE until <= $1 AND lifted_at IS NULL",
            [now]
        )
    })
    return result
}

/** Starts the hourly job; a no-op stopper when the marketplace is disabled. */
export function startMarketplaceCleanup(): () => void {
    let timer: ReturnType<typeof setInterval> | undefined
    let stopped = false
    void import('./runtime')
        .then(({ marketplaceRuntime }) => {
            if (stopped || !marketplaceRuntime) return
            const { pool, storage } = marketplaceRuntime
            let running = false
            const run = async () => {
                if (running) return
                running = true
                try {
                    await runMarketplaceCleanup({
                        pool,
                        storage,
                        now: () => new Date()
                    })
                } catch {
                    console.error('Marketplace cleanup failed')
                } finally {
                    running = false
                }
            }
            void run()
            timer = setInterval(() => void run(), HOUR)
            timer.unref()
        })
        .catch(() => {
            console.error('Marketplace cleanup could not start')
        })
    return () => {
        stopped = true
        if (timer) clearInterval(timer)
    }
}
