import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { TransactionalMailer } from '@/lib/account-mail'
import { blockHash, normaliseEmail } from '@/marketplace/block-hash'
import { blockEmail, removalEmail } from '@/marketplace/mail'

type Actor = { id: string; email: string }
export interface ModerationConfig {
    secret: string
    send?: TransactionalMailer
    now?: () => Date
}

/** Audit rows carry only who did what to which record id (in `name`); never post text or addresses. */
async function audit(
    c: Pool | PoolClient,
    actor: Actor,
    entity: string,
    operation: string,
    subject: string
) {
    await c.query(
        'INSERT INTO audit_log(entity,entity_id,operation,name,user_id,created_at) VALUES($1,NULL,$2,$3,$4,now())',
        [entity, operation, subject, actor.id]
    )
}

export function createModerationRepository(
    pool: Pool,
    config: ModerationConfig
) {
    const now = config.now ?? (() => new Date())
    /** Mail never decides the outcome: false when unconfigured or sending failed. */
    const notify = async (
        to: string | null | undefined,
        mail: { subject: string; text: string }
    ) => {
        if (!config.send || !to) return false
        try {
            await config.send({ to, ...mail })
            return true
        } catch {
            return false
        }
    }
    const transaction = async <T>(work: (c: PoolClient) => Promise<T>) => {
        const c = await pool.connect()
        try {
            await c.query('BEGIN')
            const result = await work(c)
            await c.query('COMMIT')
            return result
        } catch (e) {
            await c.query('ROLLBACK')
            throw e
        } finally {
            c.release()
        }
    }
    return {
        /** Counts only: shows no reporter or poster, so it writes no identity audit rows. */
        async openSummary() {
            const r = await pool.query(
                `SELECT count(*)::int AS open, min(created_at) AS oldest
                 FROM haw_market_report WHERE decided_at IS NULL`
            )
            return {
                open: r.rows[0].open as number,
                oldestAt: r.rows[0].oldest
                    ? new Date(r.rows[0].oldest).toISOString()
                    : null
            }
        },
        async reports(status: 'open' | 'decided', actor: Actor) {
            const r = await pool.query(
                `SELECT r.id, r.kind, r.reason, r.note, r.snapshot, r.created_at,
                        r.decision, r.decided_at, r.decision_reason,
                        rep.email AS reporter_email,
                        p.id AS post_id, p.title, p.description, p.category, p.details, p.status, p.report_count,
                        owner.email AS poster_email,
                        m.body AS message_body, sender.email AS sender_email,
                        subject.email AS subject_email
                 FROM haw_market_report r
                 LEFT JOIN haw_user rep ON rep.id = r.reporter_id
                 LEFT JOIN haw_market_post p ON p.id = r.post_id
                 LEFT JOIN haw_user owner ON owner.id = p.owner_id
                 LEFT JOIN haw_market_message m ON m.id = r.message_id
                 LEFT JOIN haw_user sender ON sender.id = m.sender_id
                 -- The reported person survives deletion of the post or message (30-day message retention).
                 LEFT JOIN haw_user subject ON subject.id = r.subject_user_id
                 WHERE ${status === 'open' ? 'r.decided_at IS NULL' : 'r.decided_at IS NOT NULL'}
                 ORDER BY r.created_at DESC, r.id DESC LIMIT 100`
            )
            const items = r.rows.map((x) => {
                const snap = (x.snapshot ?? {}) as Record<string, unknown> & {
                    title?: string
                    description?: string
                    postTitle?: string
                    body?: string
                }
                const isMessage = x.kind === 'message'
                const subjectEmail = (x.subject_email as string | null) ?? null
                return {
                    id: x.id as string,
                    kind: isMessage ? ('message' as const) : ('post' as const),
                    reason: x.reason as string,
                    note: (x.note as string | null) ?? null,
                    createdAt: new Date(x.created_at).toISOString(),
                    reportCount: (x.report_count as number | null) ?? 0,
                    post: {
                        id: (x.post_id as string | null) ?? null,
                        title: x.title ?? snap.title ?? snap.postTitle ?? '',
                        description: x.description ?? snap.description ?? '',
                        category:
                            (x.category as string | null) ??
                            (typeof snap.category === 'string'
                                ? snap.category
                                : null),
                        details: (x.details ??
                            (snap.details && typeof snap.details === 'object'
                                ? snap.details
                                : {})) as Record<string, unknown>,
                        status: (x.status as string | null) ?? 'gone',
                        posterEmail:
                            (x.poster_email as string | null) ??
                            (isMessage ? null : subjectEmail)
                    },
                    message: isMessage
                        ? {
                              body: x.message_body ?? snap.body ?? '',
                              senderEmail:
                                  (x.sender_email as string | null) ??
                                  subjectEmail
                          }
                        : null,
                    reporterEmail: (x.reporter_email as string | null) ?? null,
                    decision: (x.decision as string | null) ?? null,
                    decidedAt: x.decided_at
                        ? new Date(x.decided_at).toISOString()
                        : null,
                    decisionReason: (x.decision_reason as string | null) ?? null
                }
            })
            // Each identity view is recorded: who looked at which report, never what it said.
            if (items.length)
                await pool.query(
                    `INSERT INTO audit_log(entity,entity_id,operation,name,user_id,created_at)
                     SELECT 'marketplace_identity',NULL,'view',id,$2,now() FROM unnest($1::text[]) AS id`,
                    [items.map((i) => i.id), actor.id]
                )
            return { items }
        },

        async decide(
            id: string,
            action: 'dismiss' | 'remove',
            reason: string | null,
            actor: Actor
        ) {
            const outcome = await transaction(async (c) => {
                // Lock order is always post, then open reports (by id), so concurrent decisions cannot deadlock.
                const head = await c.query(
                    'SELECT kind, post_id FROM haw_market_report WHERE id = $1',
                    [id]
                )
                if (!head.rowCount) throw Error('NotFound')
                const decision = action === 'dismiss' ? 'dismissed' : 'removed'
                // Statement of reasons: kept with the report until the one-year retention purge.
                const storedReason = action === 'remove' ? reason : null
                let post: { title: string; email: string | null } | null = null
                if (head.rows[0].kind === 'post' && head.rows[0].post_id) {
                    const p = await c.query(
                        `SELECT p.title, u.email FROM haw_market_post p
                         LEFT JOIN haw_user u ON u.id = p.owner_id
                         WHERE p.id = $1 FOR UPDATE OF p`,
                        [head.rows[0].post_id]
                    )
                    post = p.rows[0] ?? null
                    if (post)
                        await c.query(
                            `SELECT 1 FROM haw_market_report
                             WHERE post_id = $1 AND kind = 'post' AND decided_at IS NULL
                             ORDER BY id FOR UPDATE`,
                            [head.rows[0].post_id]
                        )
                }
                const target = await c.query(
                    `SELECT decided_at FROM haw_market_report WHERE id = $1${post ? '' : ' FOR UPDATE'}`,
                    [id]
                )
                if (!target.rowCount) throw Error('NotFound')
                if (target.rows[0].decided_at) throw Error('Conflict')
                if (post) {
                    // A post decision covers every open post report; message reports stay separate.
                    await c.query(
                        `UPDATE haw_market_report SET decided_at=$2, decision=$3, decided_by=$4, decision_reason=$5
                         WHERE post_id=$1 AND kind = 'post' AND decided_at IS NULL`,
                        [
                            head.rows[0].post_id,
                            now(),
                            decision,
                            actor.email,
                            storedReason
                        ]
                    )
                    if (action === 'dismiss')
                        await c.query(
                            `UPDATE haw_market_post SET report_count=0,
                               status=CASE WHEN status='hiddenPendingReview' THEN 'active' ELSE status END
                             WHERE id=$1`,
                            [head.rows[0].post_id]
                        )
                    else
                        await c.query(
                            `UPDATE haw_market_post SET status='removedByModerator', updated_at=$2
                             WHERE id=$1`,
                            [head.rows[0].post_id, now()]
                        )
                } else
                    await c.query(
                        'UPDATE haw_market_report SET decided_at=$2, decision=$3, decided_by=$4, decision_reason=$5 WHERE id=$1',
                        [id, now(), decision, actor.email, storedReason]
                    )
                await audit(c, actor, 'marketplace_report', action, id)
                return {
                    mail:
                        action === 'remove' && post
                            ? { to: post.email, title: post.title }
                            : null
                }
            })
            const mailSent = outcome.mail
                ? await notify(
                      outcome.mail.to,
                      removalEmail({
                          postTitle: outcome.mail.title,
                          reason: reason ?? ''
                      })
                  )
                : false
            return { ok: true, mailSent }
        },

        /**
         * Every post, newest first, for moderators to browse without a report.
         * `live` = visible to students now; `hidden` = not visible (removed, expired,
         * closed, pending review or owner blocked); `all` = both.
         */
        async posts(
            filter: { view: 'live' | 'hidden' | 'all'; q: string | null },
            actor: Actor
        ) {
            const at = now()
            const blocked =
                'EXISTS (SELECT 1 FROM haw_market_block b WHERE b.user_id = p.owner_id AND b.lifted_at IS NULL AND b.until > $1)'
            const status = `CASE WHEN p.status IN ('active','reserved') AND ${blocked} THEN 'hiddenByBlock'
                     WHEN p.status IN ('active','reserved') AND p.expires_at <= $1 THEN 'expired'
                     ELSE p.status END`
            const where: string[] = []
            const params: unknown[] = [at]
            if (filter.view === 'live')
                where.push(`${status} IN ('active','reserved')`)
            if (filter.view === 'hidden')
                where.push(`${status} NOT IN ('active','reserved')`)
            if (filter.q) {
                params.push(`%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
                where.push(
                    '(p.title ILIKE $2 OR p.description ILIKE $2 OR owner.email ILIKE $2)'
                )
            }
            const r = await pool.query(
                `SELECT p.id, p.type, p.category, p.title, p.description, p.price_eur, p.price_free,
                        p.price_unit, p.location, p.details, p.report_count, p.created_at, p.expires_at,
                        ${status} AS status, owner.email AS poster_email
                 FROM haw_market_post p
                 LEFT JOIN haw_user owner ON owner.id = p.owner_id
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY p.created_at DESC, p.id DESC LIMIT 100`,
                params
            )
            const items = r.rows.map((x) => ({
                id: x.id as string,
                type: x.type as 'offer' | 'request',
                category: x.category as string,
                title: x.title as string,
                description: x.description as string,
                priceEur: (x.price_eur as number | null) ?? null,
                priceFree: x.price_free === true,
                priceUnit: (x.price_unit as string | null) ?? null,
                location: (x.location as string | null) ?? null,
                details: (x.details ?? {}) as Record<string, unknown>,
                reportCount: (x.report_count as number | null) ?? 0,
                status: x.status as string,
                posterEmail: (x.poster_email as string | null) ?? null,
                createdAt: new Date(x.created_at).toISOString(),
                expiresAt: new Date(x.expires_at).toISOString()
            }))
            // Same rule as reports: record who saw which poster identity, never the text.
            if (items.length)
                await pool.query(
                    `INSERT INTO audit_log(entity,entity_id,operation,name,user_id,created_at)
                     SELECT 'marketplace_identity',NULL,'view',id,$2,now() FROM unnest($1::text[]) AS id`,
                    [items.map((i) => i.id), actor.id]
                )
            return { items }
        },

        /** Takes a post down without a report; open post reports are closed with the same reason. */
        async removePost(id: string, reason: string, actor: Actor) {
            const post = await transaction(async (c) => {
                const p = await c.query(
                    `SELECT p.title, p.status, u.email FROM haw_market_post p
                     LEFT JOIN haw_user u ON u.id = p.owner_id
                     WHERE p.id = $1 FOR UPDATE OF p`,
                    [id]
                )
                if (!p.rowCount) throw Error('NotFound')
                const row = p.rows[0]
                if (
                    row.status === 'removedByModerator' ||
                    row.status === 'removedByOwner'
                )
                    throw Error('Conflict')
                await c.query(
                    `SELECT 1 FROM haw_market_report
                     WHERE post_id = $1 AND kind = 'post' AND decided_at IS NULL
                     ORDER BY id FOR UPDATE`,
                    [id]
                )
                await c.query(
                    `UPDATE haw_market_post SET status='removedByModerator', updated_at=$2 WHERE id=$1`,
                    [id, now()]
                )
                await c.query(
                    `UPDATE haw_market_report SET decided_at=$2, decision='removed', decided_by=$3, decision_reason=$4
                     WHERE post_id=$1 AND kind = 'post' AND decided_at IS NULL`,
                    [id, now(), actor.email, reason]
                )
                await audit(c, actor, 'marketplace_post', 'remove', id)
                return { title: row.title as string, email: row.email }
            })
            const mailSent = await notify(
                post.email,
                removalEmail({ postTitle: post.title, reason })
            )
            return { ok: true, mailSent }
        },

        /** Undoes a moderator removal; the post's own expiry still applies. */
        async restorePost(id: string, actor: Actor) {
            await transaction(async (c) => {
                const p = await c.query(
                    'SELECT status FROM haw_market_post WHERE id = $1 FOR UPDATE',
                    [id]
                )
                if (!p.rowCount) throw Error('NotFound')
                if (p.rows[0].status !== 'removedByModerator')
                    throw Error('Conflict')
                await c.query(
                    `UPDATE haw_market_post SET status='active', report_count=0, updated_at=$2 WHERE id=$1`,
                    [id, now()]
                )
                await audit(c, actor, 'marketplace_post', 'restore', id)
            })
            return { ok: true }
        },

        async blocks() {
            const r = await pool.query(
                `SELECT id, user_id, reason, until, created_by, created_at, lifted_at
                 FROM haw_market_block ORDER BY created_at DESC, id DESC LIMIT 200`
            )
            return {
                items: r.rows.map((b) => ({
                    id: b.id as string,
                    userId: (b.user_id as string | null) ?? null,
                    reason: b.reason as string,
                    until: new Date(b.until).toISOString(),
                    createdBy: b.created_by as string,
                    createdAt: new Date(b.created_at).toISOString(),
                    liftedAt: b.lifted_at
                        ? new Date(b.lifted_at).toISOString()
                        : null
                }))
            }
        },

        async block(
            input: { userEmail: string; reason: string; days: number },
            actor: Actor
        ) {
            const email = normaliseEmail(input.userEmail)
            const id = randomUUID()
            const until = new Date(now().getTime() + input.days * 86400000)
            await transaction(async (c) => {
                const u = await c.query(
                    'SELECT id FROM haw_user WHERE lower(email)=$1 LIMIT 1',
                    [email]
                )
                // Hiding is derived from a current block bound to user_id, so no post rows are rewritten.
                await c.query(
                    `INSERT INTO haw_market_block(id,user_id,email_hash,reason,until,created_by,created_at)
                     VALUES($1,$2,$3,$4,$5,$6,$7)`,
                    [
                        id,
                        u.rows[0]?.id ?? null,
                        blockHash(email, config.secret),
                        input.reason,
                        until,
                        actor.email,
                        now()
                    ]
                )
                await audit(c, actor, 'marketplace_block', 'insert', id)
            })
            const mailSent = await notify(
                email,
                blockEmail({ reason: input.reason, until })
            )
            return { id, until: until.toISOString(), mailSent }
        },

        async lift(id: string, actor: Actor) {
            await transaction(async (c) => {
                const r = await c.query(
                    `UPDATE haw_market_block SET lifted_at=$2, email_hash=''
                     WHERE id=$1 AND lifted_at IS NULL`,
                    [id, now()]
                )
                if (!r.rowCount) throw Error('NotFound')
                await audit(c, actor, 'marketplace_block', 'delete', id)
            })
            return { ok: true }
        }
    }
}
export type ModerationRepository = ReturnType<typeof createModerationRepository>
