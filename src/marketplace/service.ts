import { randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { TransactionalMailer } from '../lib/account-mail'
import { blockHash } from './block-hash'
import { purgePhotoObjects } from './cleanup'
import { contactEmail } from './mail'
import type { PhotoStorage } from './photo-storage'
import {
    canReserve,
    MARKET,
    type MarketPostInput,
    validateContactMessage,
    validatePhotoIds,
    validatePostInput,
    validateReport
} from './validation'

const DAY = 86_400_000
const ACTIVE_DAYS = 30
const RENEW_GRACE_DAYS = 30
const MESSAGE_REPORT_DAYS = 30
const MAX_ACTIVE_POSTS = 5
const CONTACTS_PER_DAY = 20
const AUTO_HIDE_REPORTERS = 3
const LIST_DEFAULT = 20
const LIST_MAX = 30
const PHOTO_URL_SECONDS = 3600

export type PostStatus =
    | 'active'
    | 'reserved'
    | 'closed'
    | 'expired'
    | 'removedByOwner'
    | 'removedByModerator'
    | 'hiddenPendingReview'
    | 'hiddenByBlock'

/** What any client sees of a post: never the owner's id, name or email. */
export interface PostView {
    id: string
    type: MarketPostInput['type']
    category: MarketPostInput['category']
    title: string
    description: string
    priceEur: number | null
    priceFree: boolean
    priceUnit: MarketPostInput['priceUnit']
    location: string | null
    availableFrom: string | null
    details: MarketPostInput['details']
    status: PostStatus
    createdAt: string
    expiresAt: string
    isOwn: boolean
    photoUrls: string[]
}

/** Post fields plus photo ids from the upload endpoint. On update, null/undefined keeps the current photos. */
export type MarketPostWrite = MarketPostInput & { photoIds?: string[] | null }

export interface MarketListFilter {
    type?: string | null
    category?: string | null
    cursor?: string | null
    limit?: number | null
}

export interface MarketReportInput {
    reason: string
    note?: string | null
}

export interface MarketplaceDeps {
    pool: Pool
    storage: PhotoStorage
    send?: TransactionalMailer
    now(): Date
    blockSecret: string
    webOrigin: string
}

const fail = (code: string): never => {
    throw new Error(code)
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
const signedIn = (viewer: string) => {
    if (!viewer) fail('SignInRequired')
}

/* SQL fragments: $1 is always "now". */
const ownerBlocked =
    'EXISTS (SELECT 1 FROM haw_market_block b WHERE b.user_id = p.owner_id AND b.lifted_at IS NULL AND b.until > $1)'
const VISIBLE = `p.status IN ('active','reserved') AND p.expires_at > $1 AND NOT ${ownerBlocked}`
/* $2 is always the viewer. owner_id is compared, never selected. */
const VIEW = `SELECT p.id, p.type, p.category, p.title, p.description, p.price_eur,
    p.price_free, p.price_unit, p.location, p.details,
    to_char(p.available_from, 'YYYY-MM-DD') AS available_from,
    CASE WHEN p.status IN ('active','reserved') AND ${ownerBlocked} THEN 'hiddenByBlock'
         WHEN p.status IN ('active','reserved') AND p.expires_at <= $1 THEN 'expired'
         ELSE p.status END AS status,
    p.created_at, p.expires_at, p.owner_id = $2 AS is_own
  FROM haw_market_post p`

type Row = Record<string, unknown>

const encodeCursor = (createdAt: Date, id: string) =>
    Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString(
        'base64url'
    )
const decodeCursor = (cursor: string): [string, string] => {
    try {
        const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        if (
            Array.isArray(v) &&
            v.length === 2 &&
            typeof v[0] === 'string' &&
            !Number.isNaN(new Date(v[0]).getTime()) &&
            isId(v[1])
        )
            return [v[0], v[1]]
    } catch {}
    return fail('InvalidMarketPost:cursor')
}

export function createMarketplace(deps: MarketplaceDeps) {
    const { pool, storage } = deps
    const webOrigin = deps.webOrigin.replace(/\/+$/, '')

    async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
        const c = await pool.connect()
        try {
            await c.query('BEGIN')
            const result = await fn(c)
            await c.query('COMMIT')
            return result
        } catch (e) {
            await c.query('ROLLBACK').catch(() => {})
            throw e
        } finally {
            c.release()
        }
    }

    /** Serialises a user's post/contact writes; returns their email. */
    async function lockUser(c: PoolClient, id: string): Promise<string> {
        const r = await c.query(
            'SELECT email FROM haw_user WHERE id = $1 FOR UPDATE',
            [id]
        )
        return r.rows[0]?.email ?? fail('SignInRequired')
    }

    async function activeCount(
        c: PoolClient,
        owner: string,
        now: Date,
        except: string | null
    ) {
        const r = await c.query(
            `SELECT count(*)::int AS n FROM haw_market_post
             WHERE owner_id = $1 AND status IN ('active','reserved','hiddenPendingReview')
               AND expires_at > $2 AND ($3::uuid IS NULL OR id <> $3)`,
            [owner, now, except]
        )
        return r.rows[0].n as number
    }

    /** Attaches the viewer's photos in order; returns object keys of photos detached from the post. */
    async function attachPhotos(
        c: PoolClient,
        owner: string,
        postId: string,
        ids: string[] | undefined
    ): Promise<string[]> {
        if (ids === undefined) return []
        if (ids.length) {
            const owned = await c.query(
                `SELECT id FROM haw_market_photo
                 WHERE id = ANY($1::uuid[]) AND owner_id = $2
                   AND (post_id IS NULL OR post_id = $3) FOR UPDATE`,
                [ids, owner, postId]
            )
            if (owned.rowCount !== ids.length)
                fail('InvalidMarketPost:photoIds')
        }
        // The delete trigger queues each key in haw_market_photo_purge in this transaction.
        const detached = await c.query(
            'DELETE FROM haw_market_photo WHERE post_id = $1 AND NOT (id = ANY($2::uuid[])) RETURNING object_key',
            [postId, ids]
        )
        await c.query(
            `UPDATE haw_market_photo ph SET post_id = $1, position = x.ord - 1
             FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id, ord) WHERE ph.id = x.id`,
            [postId, ids]
        )
        return detached.rows.map((r) => r.object_key as string)
    }

    /** Best-effort inline purge; the delete trigger already queued the keys, so the hourly cleanup retries what fails. */
    async function removeObjects(keys: string[]) {
        if (!keys.length) return
        try {
            if ((await purgePhotoObjects(pool, storage, keys)).length)
                console.error('Marketplace photo cleanup failed')
        } catch {
            console.error('Marketplace photo cleanup failed')
        }
    }

    async function toViews(rows: Row[]): Promise<PostView[]> {
        const ids = rows.map((r) => r.id as string)
        const photos = ids.length
            ? (
                  await pool.query(
                      'SELECT post_id, object_key FROM haw_market_photo WHERE post_id = ANY($1::uuid[]) ORDER BY position, created_at',
                      [ids]
                  )
              ).rows
            : []
        const keys = new Map<string, string[]>()
        for (const p of photos)
            keys.set(p.post_id, [...(keys.get(p.post_id) ?? []), p.object_key])
        return Promise.all(
            rows.map(async (r) => ({
                id: r.id as string,
                type: r.type as PostView['type'],
                category: r.category as PostView['category'],
                title: r.title as string,
                description: r.description as string,
                priceEur: (r.price_eur as number | null) ?? null,
                priceFree: r.price_free as boolean,
                priceUnit: (r.price_unit as PostView['priceUnit']) ?? null,
                location: (r.location as string | null) ?? null,
                availableFrom: (r.available_from as string | null) ?? null,
                details: (r.details as PostView['details']) ?? {},
                status: r.status as PostStatus,
                createdAt: (r.created_at as Date).toISOString(),
                expiresAt: (r.expires_at as Date).toISOString(),
                isOwn: r.is_own === true,
                photoUrls: await Promise.all(
                    (keys.get(r.id as string) ?? []).map((k) =>
                        storage.signedUrl(k, PHOTO_URL_SECONDS)
                    )
                )
            }))
        )
    }

    /** A block applies by account id or by the HMAC of the account's current email. Matching re-applies it to this account. */
    async function isBlocked(userId: string): Promise<boolean> {
        if (!userId) return false
        const now = deps.now()
        const email = (
            await pool.query('SELECT email FROM haw_user WHERE id = $1', [
                userId
            ])
        ).rows[0]?.email as string | undefined
        const hash = email ? blockHash(email, deps.blockSecret) : null
        const blocks = await pool.query(
            `SELECT id FROM haw_market_block
             WHERE lifted_at IS NULL AND until > $1 AND (user_id = $2 OR email_hash = $3)`,
            [now, userId, hash]
        )
        if (!blocks.rowCount) return false
        await pool.query(
            'UPDATE haw_market_block SET user_id = $2 WHERE id = ANY($1::uuid[]) AND user_id IS NULL',
            [blocks.rows.map((b) => b.id), userId]
        )
        // Posts are not rewritten: reads derive 'hiddenByBlock' from a current bound block,
        // so they reappear by themselves when the block ends or is lifted.
        return true
    }

    async function rulesAccepted(userId: string): Promise<boolean> {
        if (!userId) return false
        const r = await pool.query(
            'SELECT 1 FROM haw_market_rules WHERE user_id = $1 AND version >= $2',
            [userId, MARKET.rulesVersion]
        )
        return (r.rowCount ?? 0) > 0
    }

    /** Public: `viewer` is '' for a guest, who then never owns a post. */
    async function get(viewer: string, id: string): Promise<PostView | null> {
        if (!isId(id)) return null
        const r = await pool.query(
            `${VIEW} WHERE p.id = $3 AND ((p.owner_id = $2 AND p.status <> 'removedByOwner') OR (${VISIBLE}))`,
            [deps.now(), viewer, id]
        )
        return r.rowCount ? (await toViews(r.rows))[0] : null
    }

    const own = async (viewer: string, id: string) =>
        (await get(viewer, id)) ?? fail('PostUnavailable')

    return {
        isBlocked,
        rulesAccepted,
        get,

        async list(
            viewer: string,
            filter: MarketListFilter = {}
        ): Promise<{ posts: PostView[]; nextCursor: string | null }> {
            // Public: guests (viewer '') may browse; everything else needs an account.
            const params: unknown[] = [deps.now(), viewer]
            const where = [VISIBLE]
            const eq = (
                column: string,
                field: string,
                value: unknown,
                allowed: readonly string[]
            ) => {
                if (value === undefined || value === null) return
                if (typeof value !== 'string' || !allowed.includes(value))
                    fail(`InvalidMarketPost:${field}`)
                params.push(value)
                where.push(`p.${column} = $${params.length}`)
            }
            eq('type', 'type', filter.type, MARKET.types)
            eq('category', 'category', filter.category, MARKET.categories)
            if (filter.cursor) {
                const [at, id] = decodeCursor(filter.cursor)
                params.push(at, id)
                where.push(
                    `(p.created_at, p.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`
                )
            }
            const limit = Math.min(
                LIST_MAX,
                Math.max(1, Math.floor(filter.limit ?? LIST_DEFAULT) || 1)
            )
            params.push(limit + 1)
            const r = await pool.query(
                `${VIEW} WHERE ${where.join(' AND ')} ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`,
                params
            )
            const rows = r.rows.slice(0, limit)
            const last = rows.at(-1)
            return {
                posts: await toViews(rows),
                nextCursor:
                    r.rows.length > limit && last
                        ? encodeCursor(last.created_at, last.id)
                        : null
            }
        },

        async mine(viewer: string): Promise<PostView[]> {
            signedIn(viewer)
            const r = await pool.query(
                `${VIEW} WHERE p.owner_id = $2 AND p.status <> 'removedByOwner' ORDER BY p.created_at DESC, p.id DESC`,
                [deps.now(), viewer]
            )
            return toViews(r.rows)
        },

        async acceptRules(viewer: string, version: number): Promise<void> {
            signedIn(viewer)
            if (version !== MARKET.rulesVersion) fail('RulesRequired')
            await pool.query(
                `INSERT INTO haw_market_rules (user_id, version, accepted_at) VALUES ($1, $2, $3)
                 ON CONFLICT (user_id) DO UPDATE SET version = EXCLUDED.version, accepted_at = EXCLUDED.accepted_at`,
                [viewer, version, deps.now()]
            )
        },

        async create(viewer: string, raw: MarketPostWrite): Promise<PostView> {
            signedIn(viewer)
            const input = validatePostInput(raw)
            const photoIds = validatePhotoIds(raw?.photoIds)
            if (await isBlocked(viewer)) fail('Blocked')
            if (!(await rulesAccepted(viewer))) fail('RulesRequired')
            const id = randomUUID()
            const now = deps.now()
            const detached = await tx(async (c) => {
                await lockUser(c, viewer)
                if (
                    (await activeCount(c, viewer, now, null)) >=
                    MAX_ACTIVE_POSTS
                )
                    fail('ActivePostLimit')
                await c.query(
                    `INSERT INTO haw_market_post (id, owner_id, type, category, title, description,
                       price_eur, price_free, price_unit, location, available_from, details,
                       status, created_at, updated_at, expires_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'active',$13,$13,$14)`,
                    [
                        id,
                        viewer,
                        input.type,
                        input.category,
                        input.title,
                        input.description,
                        input.priceEur,
                        input.priceFree,
                        input.priceUnit,
                        input.location,
                        input.availableFrom,
                        JSON.stringify(input.details),
                        now,
                        new Date(now.getTime() + ACTIVE_DAYS * DAY)
                    ]
                )
                return attachPhotos(c, viewer, id, photoIds)
            })
            await removeObjects(detached)
            return own(viewer, id)
        },

        async update(
            viewer: string,
            id: string,
            raw: MarketPostWrite
        ): Promise<PostView> {
            signedIn(viewer)
            const input = validatePostInput(raw)
            const photoIds =
                raw?.photoIds === undefined || raw.photoIds === null
                    ? undefined
                    : validatePhotoIds(raw.photoIds)
            if (!isId(id)) fail('PostUnavailable')
            if (await isBlocked(viewer)) fail('Blocked')
            const now = deps.now()
            const detached = await tx(async (c) => {
                const post = await c.query(
                    `SELECT 1 FROM haw_market_post
                     WHERE id = $1 AND owner_id = $2 AND status IN ('active','reserved') AND expires_at > $3 FOR UPDATE`,
                    [id, viewer, now]
                )
                if (!post.rowCount) fail('PostUnavailable')
                await c.query(
                    `UPDATE haw_market_post SET type = $2, category = $3, title = $4, description = $5,
                       price_eur = $6, price_free = $7, price_unit = $8, location = $9,
                       available_from = $10, details = $11::jsonb, updated_at = $12
                     WHERE id = $1`,
                    [
                        id,
                        input.type,
                        input.category,
                        input.title,
                        input.description,
                        input.priceEur,
                        input.priceFree,
                        input.priceUnit,
                        input.location,
                        input.availableFrom,
                        JSON.stringify(input.details),
                        now
                    ]
                )
                return attachPhotos(c, viewer, id, photoIds)
            })
            await removeObjects(detached)
            return own(viewer, id)
        },

        async renew(viewer: string, id: string): Promise<PostView> {
            signedIn(viewer)
            if (!isId(id)) fail('PostUnavailable')
            if (await isBlocked(viewer)) fail('Blocked')
            const now = deps.now()
            await tx(async (c) => {
                await lockUser(c, viewer)
                const r = await c.query(
                    `SELECT status, expires_at FROM haw_market_post
                     WHERE id = $1 AND owner_id = $2 AND status IN ('active','reserved','expired') FOR UPDATE`,
                    [id, viewer]
                )
                const post = r.rows[0] ?? fail('PostUnavailable')
                const expires = (post.expires_at as Date).getTime()
                if (now.getTime() > expires + RENEW_GRACE_DAYS * DAY)
                    fail('RenewWindowClosed')
                const live =
                    post.status !== 'expired' && expires > now.getTime()
                if (
                    !live &&
                    (await activeCount(c, viewer, now, id)) >= MAX_ACTIVE_POSTS
                )
                    fail('ActivePostLimit')
                await c.query(
                    'UPDATE haw_market_post SET status = $4, expires_at = $2, updated_at = $3 WHERE id = $1',
                    [
                        id,
                        new Date(now.getTime() + ACTIVE_DAYS * DAY),
                        now,
                        live && post.status === 'reserved'
                            ? 'reserved'
                            : 'active'
                    ]
                )
            })
            return own(viewer, id)
        },

        async setStatus(
            viewer: string,
            id: string,
            target: 'active' | 'reserved' | 'closed'
        ): Promise<PostView> {
            signedIn(viewer)
            if (!isId(id)) fail('PostUnavailable')
            if (!(MARKET.ownerStatuses as readonly string[]).includes(target))
                fail('InvalidMarketStatus')
            if (await isBlocked(viewer)) fail('Blocked')
            const now = deps.now()
            await tx(async (c) => {
                await lockUser(c, viewer)
                const r = await c.query(
                    `SELECT status, category, expires_at FROM haw_market_post
                     WHERE id = $1 AND owner_id = $2
                       AND status IN ('active','reserved','closed','expired') FOR UPDATE`,
                    [id, viewer]
                )
                const post = r.rows[0] ?? fail('PostUnavailable')
                const from = post.status as string
                const expired =
                    from === 'expired' ||
                    (from !== 'closed' &&
                        (post.expires_at as Date).getTime() <= now.getTime())
                // Expired listings are renewed, not re-statused.
                if (expired) fail('InvalidMarketStatus')
                if (from === target) return
                if (target === 'reserved') {
                    if (from === 'closed' || !canReserve(post.category))
                        fail('InvalidMarketStatus')
                } else if (from === 'closed') {
                    // reopen
                    if ((post.expires_at as Date).getTime() <= now.getTime())
                        fail('MarketPostExpired')
                    if (
                        (await activeCount(c, viewer, now, id)) >=
                        MAX_ACTIVE_POSTS
                    )
                        fail('ActivePostLimit')
                }
                await c.query(
                    'UPDATE haw_market_post SET status = $2, updated_at = $3 WHERE id = $1',
                    [id, target, now]
                )
            })
            return own(viewer, id)
        },

        async remove(viewer: string, id: string): Promise<void> {
            signedIn(viewer)
            if (!isId(id)) fail('PostUnavailable')
            const r = await pool.query(
                `UPDATE haw_market_post SET status = 'removedByOwner', updated_at = $3
                 WHERE id = $1 AND owner_id = $2 AND status <> 'removedByOwner'`,
                [id, viewer, deps.now()]
            )
            if (!r.rowCount) fail('PostUnavailable')
        },

        async report(
            viewer: string,
            postId: string,
            raw: MarketReportInput
        ): Promise<void> {
            signedIn(viewer)
            const { reason, note } = validateReport(raw)
            if (!isId(postId)) fail('PostUnavailable')
            const now = deps.now()
            await tx(async (c) => {
                const r = await c.query(
                    `SELECT p.owner_id, p.title, p.description, p.category, p.details FROM haw_market_post p
                     WHERE p.id = $2 AND ${VISIBLE} FOR UPDATE`,
                    [now, postId]
                )
                const post = r.rows[0] ?? fail('PostUnavailable')
                if (post.owner_id === viewer) fail('OwnPost')
                const inserted = await c.query(
                    `INSERT INTO haw_market_report (id, kind, post_id, reporter_id, reason, note, snapshot, created_at, subject_user_id)
                     VALUES ($1, 'post', $2, $3, $4, $5, $6, $7, $8)
                     ON CONFLICT (post_id, reporter_id) WHERE kind = 'post' DO NOTHING`,
                    [
                        randomUUID(),
                        postId,
                        viewer,
                        reason,
                        note,
                        {
                            title: post.title,
                            description: post.description,
                            category: post.category,
                            details: post.details
                        },
                        now,
                        post.owner_id
                    ]
                )
                if (!inserted.rowCount) fail('AlreadyReported')
                await c.query(
                    `UPDATE haw_market_post p SET report_count = x.n,
                       status = CASE WHEN x.n >= $2 AND p.status IN ('active','reserved') THEN 'hiddenPendingReview' ELSE p.status END
                     FROM (SELECT count(DISTINCT reporter_id)::int AS n FROM haw_market_report
                           WHERE post_id = $1 AND kind = 'post' AND decided_at IS NULL) x
                     WHERE p.id = $1`,
                    [postId, AUTO_HIDE_REPORTERS]
                )
            })
        },

        async reportMessage(
            viewer: string,
            token: string,
            raw: MarketReportInput
        ): Promise<void> {
            signedIn(viewer)
            const { reason, note } = validateReport(raw)
            if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
                fail('PostUnavailable')
            const now = deps.now()
            await tx(async (c) => {
                const r = await c.query(
                    `SELECT m.id, m.post_id, m.body, m.sender_id, p.title FROM haw_market_message m
                     JOIN haw_market_post p ON p.id = m.post_id
                     WHERE m.report_token = $1 AND m.recipient_id = $2 AND m.created_at > $3
                     FOR UPDATE OF m`,
                    [
                        token,
                        viewer,
                        new Date(now.getTime() - MESSAGE_REPORT_DAYS * DAY)
                    ]
                )
                const message = r.rows[0] ?? fail('PostUnavailable')
                const existing = await c.query(
                    'SELECT 1 FROM haw_market_report WHERE message_id = $1 AND reporter_id = $2',
                    [message.id, viewer]
                )
                if (existing.rowCount) fail('AlreadyReported')
                await c.query(
                    `INSERT INTO haw_market_report (id, kind, post_id, message_id, reporter_id, reason, note, snapshot, created_at, subject_user_id)
                     VALUES ($1, 'message', $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [
                        randomUUID(),
                        message.post_id,
                        message.id,
                        viewer,
                        reason,
                        note,
                        { body: message.body, postTitle: message.title },
                        now,
                        message.sender_id
                    ]
                )
            })
        },

        async contact(
            viewer: string,
            postId: string,
            raw: string
        ): Promise<void> {
            signedIn(viewer)
            const body = validateContactMessage(raw)
            const send = deps.send ?? fail('MailUnavailable')
            if (!isId(postId)) fail('PostUnavailable')
            if (await isBlocked(viewer)) fail('Blocked')
            const now = deps.now()
            const post =
                (
                    await pool.query(
                        `SELECT p.owner_id, p.title, u.email FROM haw_market_post p
                         JOIN haw_user u ON u.id = p.owner_id
                         WHERE p.id = $2 AND ${VISIBLE}`,
                        [now, postId]
                    )
                ).rows[0] ?? fail('PostUnavailable')
            if (post.owner_id === viewer) fail('OwnPost')
            if (await isBlocked(post.owner_id)) fail('PostUnavailable')
            const messageId = randomUUID()
            const token = randomBytes(32).toString('base64url')
            // Short transaction: no network I/O while the connection and sender lock are held.
            const { senderEmail, recipient, title } = await tx(async (c) => {
                const senderEmail = await lockUser(c, viewer)
                const current =
                    (
                        await c.query(
                            `SELECT p.owner_id, p.title, u.email FROM haw_market_post p
                             JOIN haw_user u ON u.id = p.owner_id
                             WHERE p.id = $2 AND ${VISIBLE}`,
                            [now, postId]
                        )
                    ).rows[0] ?? fail('PostUnavailable')
                if (current.owner_id === viewer) fail('OwnPost')
                const counts = (
                    await c.query(
                        `SELECT count(*)::int AS total, count(*) FILTER (WHERE post_id = $3)::int AS same
                         FROM haw_market_message WHERE sender_id = $1 AND created_at > $2`,
                        [viewer, new Date(now.getTime() - DAY), postId]
                    )
                ).rows[0]
                if (counts.same >= 1 || counts.total >= CONTACTS_PER_DAY)
                    fail('ContactLimit')
                await c.query(
                    `INSERT INTO haw_market_message (id, post_id, sender_id, recipient_id, body, report_token, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [
                        messageId,
                        postId,
                        viewer,
                        current.owner_id,
                        body,
                        token,
                        now
                    ]
                )
                return {
                    senderEmail,
                    recipient: current.email as string,
                    title: current.title as string
                }
            })
            const mail = contactEmail({
                postTitle: title,
                message: body,
                reportUrl: `${webOrigin}/marketplace/report/${token}`
            })
            try {
                await send({ to: recipient, replyTo: senderEmail, ...mail })
            } catch {
                // Compensate so the rate-limit slot is freed and no orphan token remains.
                await pool
                    .query('DELETE FROM haw_market_message WHERE id = $1', [
                        messageId
                    ])
                    .catch(() =>
                        console.error('Marketplace message compensation failed')
                    )
                fail('MailUnavailable')
            }
        }
    }
}

export type Marketplace = ReturnType<typeof createMarketplace>
