import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import express from 'express'
import { Pool } from 'pg'
import type { AccountAuthService } from '@/lib/account-auth'
import type { TransactionalMail } from '@/lib/account-mail'
import { blockHash } from '@/marketplace/block-hash'
import { createMarketplace } from '@/marketplace/service'
import { createModerationRepository } from '../marketplace'
import { createAdminRepository } from '../repository'
import { createAdminRouter } from '../router'

const database = process.env.HAWCONNECT_ADMIN_TEST_DATABASE_URL
const run = database ? test : test.skip
const origin = 'http://localhost:43127'
const secret = 'moderation-test-secret-at-least-thirty-two-chars'
let pool: Pool
let server: Server
let base: string
let mails: TransactionalMail[]
let mailer: 'none' | 'ok' | 'fail' = 'ok'
const post1 = '00000000-0000-4000-8000-000000000001'
const report1 = '00000000-0000-4000-8000-0000000000a1'
const report2 = '00000000-0000-4000-8000-0000000000a2'
const report3 = '00000000-0000-4000-8000-0000000000a3'
const message1 = '00000000-0000-4000-8000-0000000000b1'

beforeAll(async () => {
    if (!database) return
    const url = new URL(database)
    if (
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        !url.pathname.endsWith('/hawconnect_console_test')
    )
        throw Error('IsolatedAdminTestDatabaseRequired')
    pool = new Pool({ connectionString: database })
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    for (const file of (
        await readdir(new URL('../../db/migrations/', import.meta.url))
    )
        .filter((f) => f.endsWith('.sql'))
        .sort())
        await pool.query(
            await readFile(
                new URL(`../../db/migrations/${file}`, import.meta.url),
                'utf8'
            )
        )
    await pool.query(
        'CREATE TABLE haw_user (id text PRIMARY KEY, email text NOT NULL)'
    )
    for (const f of ['admin.sql', 'marketplace.sql'])
        await pool.query(
            await readFile(
                new URL(`../../db/accounts/${f}`, import.meta.url),
                'utf8'
            )
        )
    const repo = createAdminRepository(pool, ['maintainer@haw-hamburg.de'])
    const actor = { id: 'admin-id', email: 'maintainer@haw-hamburg.de' }
    await repo.setPermissions('mod@haw-hamburg.de', ['marketplace'], actor)
    await repo.setPermissions('events@haw-hamburg.de', ['events'], actor)
    const moderation = createModerationRepository(pool, {
        secret,
        now: () => new Date(),
        send: async (m) => {
            if (mailer === 'none') throw Error('unused')
            if (mailer === 'fail') throw Error('smtp down')
            mails.push(m)
        }
    })
    const sessions: Record<string, { id: string; email: string }> = {
        admin: { id: 'admin-id', email: 'maintainer@haw-hamburg.de' },
        mod: { id: 'mod-id', email: 'mod@haw-hamburg.de' },
        events: { id: 'events-id', email: 'events@haw-hamburg.de' }
    }
    const stub = {
        session: async (h: Headers) => {
            const user =
                sessions[h.get('authorization')?.slice(7) ?? ''] ?? null
            return user
                ? {
                      user: { ...user, emailVerified: true },
                      session: { expiresAt: new Date() }
                  }
                : null
        }
    } as unknown as AccountAuthService
    const app = express()
    const dependencies = (m: typeof moderation | null) => ({
        origin,
        auth: stub,
        repository: repo,
        status: async () => [],
        marketplace: m
    })
    app.use('/api/admin', createAdminRouter(dependencies(moderation)))
    app.use('/off/admin', createAdminRouter(dependencies(null)))
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>((r) => server.once('listening', r))
    const address = server.address()
    if (!address || typeof address === 'string') throw Error()
    base = `http://127.0.0.1:${address.port}`
})
afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()))
    if (pool) await pool.end()
})
beforeEach(async () => {
    if (!pool) return
    mails = []
    mailer = 'ok'
    await pool.query(
        'TRUNCATE haw_market_report, haw_market_message, haw_market_post, haw_market_block, haw_user, audit_log RESTART IDENTITY CASCADE'
    )
    await pool.query(
        "INSERT INTO haw_user VALUES ('poster','poster@haw-hamburg.de'),('rep1','rep1@haw-hamburg.de'),('rep2','rep2@haw-hamburg.de'),('sender','sender@haw-hamburg.de')"
    )
    await pool.query(
        `INSERT INTO haw_market_post(id,owner_id,type,category,title,description,status,report_count,expires_at,details)
         VALUES ($1,'poster','offer','jobs','Sofa','Gratis sofa','hiddenPendingReview',2,now()+interval '10 days','{"jobType":"partTime"}')`,
        [post1]
    )
    await pool.query(
        `INSERT INTO haw_market_report(id,kind,post_id,reporter_id,reason,note,snapshot,created_at) VALUES
         ($1,'post',$3,'rep1','scam','sus','{"title":"Sofa","description":"Gratis sofa"}',now()),
         ($2,'post',$3,'rep2','spam',NULL,'{"title":"Sofa","description":"Gratis sofa"}',now())`,
        [report1, report2, post1]
    )
})
async function call(
    path: string,
    as: string,
    method = 'GET',
    body?: unknown,
    prefix = '/api/admin'
) {
    return fetch(`${base}${prefix}${path}`, {
        method,
        headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            Authorization: `Bearer ${as}`
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
}
const auditRows = async () =>
    (await pool.query('SELECT * FROM audit_log ORDER BY id')).rows

run(
    'capability gate: events-only 403, marketplace and admin allowed',
    async () => {
        expect((await call('/marketplace/reports', 'events')).status).toBe(403)
        expect((await call('/marketplace/blocks', 'events')).status).toBe(403)
        expect((await call('/marketplace/reports', 'mod')).status).toBe(200)
        expect((await call('/marketplace/reports', 'admin')).status).toBe(200)
    }
)

run('disabled marketplace answers 503 after the capability check', async () => {
    const r = await call(
        '/marketplace/reports',
        'mod',
        'GET',
        undefined,
        '/off/admin'
    )
    expect(r.status).toBe(503)
    expect(await r.json()).toEqual({ error: 'MarketplaceUnavailable' })
    expect(
        (
            await call(
                '/marketplace/reports',
                'events',
                'GET',
                undefined,
                '/off/admin'
            )
        ).status
    ).toBe(403)
})

run(
    'listing shows emails and audits one identity view per item without text',
    async () => {
        await pool.query(
            `INSERT INTO haw_market_message(id,post_id,sender_id,recipient_id,body,report_token) VALUES ($1,$2,'sender','poster','Rude words','tok')`,
            [message1, post1]
        )
        await pool.query(
            `INSERT INTO haw_market_report(id,kind,post_id,message_id,reporter_id,reason,snapshot,created_at) VALUES ($1,'message',$2,$3,'poster','offensive','{"body":"Rude words","postTitle":"Sofa"}',now())`,
            [report3, post1, message1]
        )
        const r = await call('/marketplace/reports', 'mod')
        const { items } = await r.json()
        expect(items).toHaveLength(3)
        const postItem = items.find((i: { id: string }) => i.id === report1)
        expect(postItem).toMatchObject({
            kind: 'post',
            reason: 'scam',
            note: 'sus',
            reporterEmail: 'rep1@haw-hamburg.de',
            reportCount: 2,
            message: null,
            post: {
                id: post1,
                title: 'Sofa',
                description: 'Gratis sofa',
                status: 'hiddenPendingReview',
                posterEmail: 'poster@haw-hamburg.de',
                category: 'jobs',
                details: { jobType: 'partTime' }
            }
        })
        const msgItem = items.find((i: { id: string }) => i.id === report3)
        expect(msgItem.kind).toBe('message')
        expect(msgItem.message).toEqual({
            body: 'Rude words',
            senderEmail: 'sender@haw-hamburg.de'
        })
        const rows = (await auditRows()).filter(
            (a) => a.entity === 'marketplace_identity'
        )
        expect(rows).toHaveLength(3)
        for (const a of rows) {
            expect(a.operation).toBe('view')
            expect(a.user_id).toBe('mod-id')
            expect(JSON.stringify(a)).not.toMatch(/Sofa|Rude|sus/)
        }
        expect(rows.map((a) => a.name).sort()).toEqual(
            [report1, report2, report3].sort()
        )
    }
)

run(
    'listing falls back to the snapshot when the post is gone; status filter',
    async () => {
        await pool.query(
            `UPDATE haw_market_report SET snapshot = '{"title":"Sofa","description":"Gratis sofa","category":"jobs","details":{"jobType":"partTime"}}' WHERE id=$1`,
            [report2]
        )
        await pool.query('DELETE FROM haw_market_post')
        const { items } = await (
            await call('/marketplace/reports', 'mod')
        ).json()
        expect(items).toHaveLength(2)
        const byId = (id: string) =>
            items.find((i: { id: string }) => i.id === id)
        expect(byId(report2).post).toMatchObject({
            id: null,
            title: 'Sofa',
            description: 'Gratis sofa',
            posterEmail: null,
            category: 'jobs',
            details: { jobType: 'partTime' }
        })
        expect(byId(report1).post).toMatchObject({
            id: null,
            category: null,
            details: {}
        })
        await pool.query(
            "UPDATE haw_market_report SET decided_at=now(), decision='dismissed' WHERE id=$1",
            [report1]
        )
        const open = await (
            await call('/marketplace/reports?status=open', 'mod')
        ).json()
        const decided = await (
            await call('/marketplace/reports?status=decided', 'mod')
        ).json()
        expect(open.items.map((i: { id: string }) => i.id)).toEqual([report2])
        expect(decided.items.map((i: { id: string }) => i.id)).toEqual([
            report1
        ])
        expect(
            (await call('/marketplace/reports?status=x', 'mod')).status
        ).toBe(400)
    }
)

run(
    'dismiss restores the post, resets the count and decides all open reports',
    async () => {
        const r = await call(
            `/marketplace/reports/${report1}/decision`,
            'mod',
            'POST',
            { action: 'dismiss' }
        )
        expect(r.status).toBe(200)
        expect((await r.json()).mailSent).toBe(false)
        const post = (
            await pool.query('SELECT status,report_count FROM haw_market_post')
        ).rows[0]
        expect(post).toEqual({ status: 'active', report_count: 0 })
        const reports = (
            await pool.query(
                'SELECT decision,decided_by,decided_at FROM haw_market_report'
            )
        ).rows
        for (const x of reports) {
            expect(x.decision).toBe('dismissed')
            expect(x.decided_by).toBe('mod@haw-hamburg.de')
            expect(x.decided_at).not.toBeNull()
        }
        expect(mails).toHaveLength(0)
        const a = (await auditRows()).find(
            (x) => x.entity === 'marketplace_report'
        )
        expect(a).toMatchObject({ operation: 'dismiss', user_id: 'mod-id' })
        expect(JSON.stringify(a)).not.toContain('Sofa')
        expect(
            (
                await call(
                    `/marketplace/reports/${report1}/decision`,
                    'mod',
                    'POST',
                    { action: 'dismiss' }
                )
            ).status
        ).toBe(409)
    }
)

run(
    'remove needs a reason, removes the post and mails the reason',
    async () => {
        const path = `/marketplace/reports/${report1}/decision`
        expect(
            (await call(path, 'mod', 'POST', { action: 'remove' })).status
        ).toBe(400)
        expect(
            (
                await call(path, 'mod', 'POST', {
                    action: 'remove',
                    reason: 'ab'
                })
            ).status
        ).toBe(400)
        expect(
            (
                await call(path, 'mod', 'POST', {
                    action: 'remove',
                    reason: 'x'.repeat(501)
                })
            ).status
        ).toBe(400)
        const r = await call(path, 'mod', 'POST', {
            action: 'remove',
            reason: 'Scam listing'
        })
        expect(r.status).toBe(200)
        expect((await r.json()).mailSent).toBe(true)
        expect(mails).toHaveLength(1)
        expect(mails[0].to).toBe('poster@haw-hamburg.de')
        expect(mails[0].text).toContain('Scam listing')
        expect(
            (await pool.query('SELECT status FROM haw_market_post')).rows[0]
                .status
        ).toBe('removedByModerator')
        expect(
            (
                await pool.query(
                    "SELECT count(*)::int n FROM haw_market_report WHERE decision='removed'"
                )
            ).rows[0].n
        ).toBe(2)
    }
)

run('mail failure or missing mailer never fails the decision', async () => {
    mailer = 'fail'
    const r = await call(
        `/marketplace/reports/${report1}/decision`,
        'mod',
        'POST',
        { action: 'remove', reason: 'Scam listing' }
    )
    expect(r.status).toBe(200)
    expect((await r.json()).mailSent).toBe(false)
    expect(
        (await pool.query('SELECT status FROM haw_market_post')).rows[0].status
    ).toBe('removedByModerator')
})

run(
    'message report removal marks it decided and changes nothing else',
    async () => {
        await pool.query(
            `INSERT INTO haw_market_message(id,post_id,sender_id,recipient_id,body,report_token) VALUES ($1,$2,'sender','poster','Rude words','tok')`,
            [message1, post1]
        )
        await pool.query(
            `INSERT INTO haw_market_report(id,kind,post_id,message_id,reporter_id,reason,snapshot,created_at) VALUES ($1,'message',$2,$3,'poster','offensive','{}',now())`,
            [report3, post1, message1]
        )
        const r = await call(
            `/marketplace/reports/${report3}/decision`,
            'mod',
            'POST',
            { action: 'remove', reason: 'Harassment' }
        )
        expect(r.status).toBe(200)
        expect((await r.json()).mailSent).toBe(false)
        expect(
            (await pool.query('SELECT status FROM haw_market_post')).rows[0]
                .status
        ).toBe('hiddenPendingReview')
        expect(
            (
                await pool.query(
                    'SELECT decision FROM haw_market_report WHERE id=$1',
                    [report3]
                )
            ).rows[0].decision
        ).toBe('removed')
        expect(
            (
                await pool.query(
                    'SELECT decision FROM haw_market_report WHERE id=$1',
                    [report1]
                )
            ).rows[0].decision
        ).toBeNull()
        expect(mails).toHaveLength(0)
        expect(
            (await pool.query('SELECT count(*)::int n FROM haw_market_block'))
                .rows[0].n
        ).toBe(0)
    }
)

run('unknown report is 404, malformed id or action is 400', async () => {
    const missing = '00000000-0000-4000-8000-0000000000ff'
    expect(
        (
            await call(
                `/marketplace/reports/${missing}/decision`,
                'mod',
                'POST',
                { action: 'dismiss' }
            )
        ).status
    ).toBe(404)
    expect(
        (
            await call('/marketplace/reports/nope/decision', 'mod', 'POST', {
                action: 'dismiss'
            })
        ).status
    ).toBe(400)
    expect(
        (
            await call(
                `/marketplace/reports/${report1}/decision`,
                'mod',
                'POST',
                { action: 'ban' }
            )
        ).status
    ).toBe(400)
})

run('block: validation, binding to account, hash, mail, audit', async () => {
    for (const days of [0, 366, 1.5, '7'])
        expect(
            (
                await call('/marketplace/blocks', 'mod', 'POST', {
                    userEmail: 'poster@haw-hamburg.de',
                    reason: 'Scam',
                    days
                })
            ).status
        ).toBe(400)
    expect(
        (
            await call('/marketplace/blocks', 'mod', 'POST', {
                userEmail: 'not-an-email',
                reason: 'Scam',
                days: 7
            })
        ).status
    ).toBe(400)
    expect(
        (
            await call('/marketplace/blocks', 'mod', 'POST', {
                userEmail: 'poster@haw-hamburg.de',
                reason: 'x',
                days: 7
            })
        ).status
    ).toBe(400)
    const r = await call('/marketplace/blocks', 'mod', 'POST', {
        userEmail: ' Poster@HAW-Hamburg.de ',
        reason: 'Scam repeat',
        days: 7
    })
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.mailSent).toBe(true)
    const row = (await pool.query('SELECT * FROM haw_market_block')).rows[0]
    expect(row.user_id).toBe('poster')
    expect(row.email_hash).toBe(blockHash('poster@haw-hamburg.de', secret))
    expect(row.created_by).toBe('mod@haw-hamburg.de')
    expect(row.lifted_at).toBeNull()
    const days = (row.until.getTime() - Date.now()) / 86400000
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThan(7.1)
    expect(mails[0].to).toBe('poster@haw-hamburg.de')
    expect(mails[0].text).toContain('Scam repeat')
    // hiding is derived, never stored
    expect(
        (await pool.query('SELECT status FROM haw_market_post')).rows[0].status
    ).toBe('hiddenPendingReview')
    const a = (await auditRows()).find((x) => x.entity === 'marketplace_block')
    expect(a).toMatchObject({ operation: 'insert', user_id: 'mod-id' })
    expect(JSON.stringify(a)).not.toContain('poster@')
})

run(
    'block for an unknown email stores a null user and still hashes',
    async () => {
        mailer = 'none'
        const r = await call('/marketplace/blocks', 'mod', 'POST', {
            userEmail: 'ghost@haw-hamburg.de',
            reason: 'Scam repeat',
            days: 30
        })
        expect(r.status).toBe(200)
        expect((await r.json()).mailSent).toBe(false)
        const row = (await pool.query('SELECT * FROM haw_market_block')).rows[0]
        expect(row.user_id).toBeNull()
        expect(row.email_hash).toBe(blockHash('ghost@haw-hamburg.de', secret))
    }
)

run('list and lift blocks: lifted clears the hash', async () => {
    const created = await (
        await call('/marketplace/blocks', 'mod', 'POST', {
            userEmail: 'poster@haw-hamburg.de',
            reason: 'Scam repeat',
            days: 7
        })
    ).json()
    const { items } = await (await call('/marketplace/blocks', 'mod')).json()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
        id: created.id,
        userId: 'poster',
        reason: 'Scam repeat',
        liftedAt: null
    })
    expect(JSON.stringify(items)).not.toContain(
        blockHash('poster@haw-hamburg.de', secret)
    )
    expect(
        (await call(`/marketplace/blocks/${created.id}`, 'mod', 'DELETE'))
            .status
    ).toBe(200)
    const row = (await pool.query('SELECT * FROM haw_market_block')).rows[0]
    expect(row.lifted_at).not.toBeNull()
    expect(row.email_hash).toBe('')
    expect(
        (await call(`/marketplace/blocks/${created.id}`, 'mod', 'DELETE'))
            .status
    ).toBe(404)
    expect(
        (await call('/marketplace/blocks/zzz', 'mod', 'DELETE')).status
    ).toBe(400)
    expect(
        (
            await pool.query(
                "SELECT count(*)::int n FROM audit_log WHERE entity='marketplace_block' AND operation='delete'"
            )
        ).rows[0].n
    ).toBe(1)
})

run(
    'a message report whose message was deleted never touches the post',
    async () => {
        await pool.query(
            `INSERT INTO haw_market_message(id,post_id,sender_id,recipient_id,body,report_token) VALUES ($1,$2,'sender','poster','Rude words','tok')`,
            [message1, post1]
        )
        await pool.query(
            `INSERT INTO haw_market_report(id,kind,post_id,message_id,reporter_id,reason,snapshot,created_at) VALUES ($1,'message',$2,$3,'poster','offensive','{"body":"Rude words","postTitle":"Sofa"}',now())`,
            [report3, post1, message1]
        )
        await pool.query('DELETE FROM haw_market_message')
        const { items } = await (
            await call('/marketplace/reports', 'mod')
        ).json()
        const item = items.find((i: { id: string }) => i.id === report3)
        expect(item.kind).toBe('message')
        expect(item.message.body).toBe('Rude words')
        for (const body of [
            { action: 'dismiss' },
            { action: 'remove', reason: 'Harassment' }
        ]) {
            await pool.query(
                'UPDATE haw_market_report SET decided_at=NULL, decision=NULL WHERE id=$1',
                [report3]
            )
            const r = await call(
                `/marketplace/reports/${report3}/decision`,
                'mod',
                'POST',
                body
            )
            expect(r.status).toBe(200)
            expect((await r.json()).mailSent).toBe(false)
            const post = (
                await pool.query(
                    'SELECT status,report_count FROM haw_market_post'
                )
            ).rows[0]
            expect(post).toEqual({
                status: 'hiddenPendingReview',
                report_count: 2
            })
            const open = await pool.query(
                'SELECT count(*)::int n FROM haw_market_report WHERE decided_at IS NULL'
            )
            expect(open.rows[0].n).toBe(2)
        }
        expect(mails).toHaveLength(0)
    }
)

run(
    'concurrent decisions on two reports of one post do not deadlock',
    async () => {
        for (let i = 0; i < 10; i++) {
            await pool.query(
                "UPDATE haw_market_report SET decided_at=NULL, decision=NULL; UPDATE haw_market_post SET status='hiddenPendingReview'"
            )
            const results = await Promise.all([
                call(
                    `/marketplace/reports/${report1}/decision`,
                    'mod',
                    'POST',
                    { action: 'dismiss' }
                ),
                call(
                    `/marketplace/reports/${report2}/decision`,
                    'admin',
                    'POST',
                    { action: 'dismiss' }
                )
            ])
            const codes = results.map((r) => r.status).sort()
            expect(codes.every((c) => c === 200 || c === 409)).toBe(true)
            expect(codes).toContain(200)
        }
    }
)

run(
    "lifting a block makes the poster's unexpired post visible again",
    async () => {
        await pool.query(
            "UPDATE haw_market_post SET status='active', report_count=0"
        )
        const service = createMarketplace({
            pool,
            storage: {
                put: async () => {},
                signedUrl: async () => '',
                remove: async () => {}
            },
            now: () => new Date(),
            blockSecret: secret,
            webOrigin: origin
        })
        expect((await service.get('rep1', post1))?.id).toBe(post1)
        const created = await (
            await call('/marketplace/blocks', 'mod', 'POST', {
                userEmail: 'poster@haw-hamburg.de',
                reason: 'Scam repeat',
                days: 7
            })
        ).json()
        expect(await service.get('rep1', post1)).toBeNull()
        expect(
            (await call(`/marketplace/blocks/${created.id}`, 'mod', 'DELETE'))
                .status
        ).toBe(200)
        expect((await service.get('rep1', post1))?.id).toBe(post1)
    }
)

const marketplaceService = () =>
    createMarketplace({
        pool,
        storage: {
            put: async () => {},
            signedUrl: async () => '',
            remove: async () => {}
        },
        now: () => new Date(),
        blockSecret: secret,
        webOrigin: origin
    })

run(
    'reported person stays resolvable after the message and the post are deleted',
    async () => {
        await pool.query(
            "UPDATE haw_market_post SET status='active', report_count=0"
        )
        await pool.query('DELETE FROM haw_market_report')
        const token = 'm'.repeat(43)
        await pool.query(
            `INSERT INTO haw_market_message(id,post_id,sender_id,recipient_id,body,report_token) VALUES ($1,$2,'sender','poster','Rude words',$3)`,
            [message1, post1, token]
        )
        const service = marketplaceService()
        await service.reportMessage('poster', token, { reason: 'offensive' })
        await service.report('rep1', post1, { reason: 'scam' })
        await pool.query('DELETE FROM haw_market_message')
        await pool.query('DELETE FROM haw_market_post')
        const { items } = await (
            await call('/marketplace/reports', 'mod')
        ).json()
        const message = items.find(
            (i: { kind: string }) => i.kind === 'message'
        )
        expect(message.message).toEqual({
            body: 'Rude words',
            senderEmail: 'sender@haw-hamburg.de'
        })
        const postReport = items.find(
            (i: { kind: string }) => i.kind === 'post'
        )
        expect(postReport.post.posterEmail).toBe('poster@haw-hamburg.de')
    }
)

run(
    'migration backfills the reported person and is safe to re-run on a populated database',
    async () => {
        await pool.query(
            `INSERT INTO haw_market_message(id,post_id,sender_id,recipient_id,body,report_token) VALUES ($1,$2,'sender','poster','Rude words','tok')`,
            [message1, post1]
        )
        await pool.query(
            `INSERT INTO haw_market_report(id,kind,post_id,message_id,reporter_id,reason,snapshot,created_at) VALUES ($1,'message',$2,$3,'poster','offensive','{"body":"Rude words"}',now())`,
            [report3, post1, message1]
        )
        const sql = await readFile(
            new URL('../../db/accounts/marketplace.sql', import.meta.url),
            'utf8'
        )
        for (let i = 0; i < 2; i++) {
            const c = await pool.connect()
            try {
                await c.query('BEGIN')
                await c.query(sql)
                await c.query('COMMIT')
            } finally {
                c.release()
            }
        }
        const subjects = (
            await pool.query(
                'SELECT id, subject_user_id FROM haw_market_report ORDER BY id'
            )
        ).rows
        expect(subjects).toEqual([
            { id: report1, subject_user_id: 'poster' },
            { id: report2, subject_user_id: 'poster' },
            { id: report3, subject_user_id: 'sender' }
        ])
    }
)

run(
    'removal reason is stored and returned in the decided listing; dismissals have none',
    async () => {
        await pool.query(
            `INSERT INTO haw_market_message(id,post_id,sender_id,recipient_id,body,report_token) VALUES ($1,$2,'sender','poster','Rude words','tok')`,
            [message1, post1]
        )
        await pool.query(
            `INSERT INTO haw_market_report(id,kind,post_id,message_id,reporter_id,reason,snapshot,created_at) VALUES ($1,'message',$2,$3,'poster','offensive','{"body":"Rude words"}',now())`,
            [report3, post1, message1]
        )
        expect(
            (
                await call(
                    `/marketplace/reports/${report1}/decision`,
                    'mod',
                    'POST',
                    { action: 'remove', reason: 'Scam listing' }
                )
            ).status
        ).toBe(200)
        expect(
            (
                await call(
                    `/marketplace/reports/${report3}/decision`,
                    'mod',
                    'POST',
                    { action: 'dismiss' }
                )
            ).status
        ).toBe(200)
        const { items } = await (
            await call('/marketplace/reports?status=decided', 'mod')
        ).json()
        const byId = (id: string) =>
            items.find((i: { id: string }) => i.id === id)
        for (const id of [report1, report2])
            expect(byId(id)).toMatchObject({
                decision: 'removed',
                decisionReason: 'Scam listing'
            })
        expect(byId(report1).decidedAt).toEqual(expect.any(String))
        expect(byId(report3)).toMatchObject({
            decision: 'dismissed',
            decisionReason: null
        })
        const open = await (await call('/marketplace/reports', 'mod')).json()
        expect(open.items).toEqual([])
    }
)

run('post list: views, search, emails and audited identity views', async () => {
    const post2 = '00000000-0000-4000-8000-000000000002'
    await pool.query(
        `INSERT INTO haw_market_post(id,owner_id,type,category,title,description,status,expires_at)
         VALUES ($1,'sender','request','housing','Zimmer gesucht','100% ruhig','active',now()+interval '10 days')`,
        [post2]
    )
    expect((await call('/marketplace/posts', 'events')).status).toBe(403)
    const all = await (await call('/marketplace/posts', 'mod')).json()
    expect(all.items.map((i: { id: string }) => i.id).sort()).toEqual(
        [post1, post2].sort()
    )
    const live = await (
        await call('/marketplace/posts?view=live', 'mod')
    ).json()
    expect(live.items).toHaveLength(1)
    expect(live.items[0]).toMatchObject({
        id: post2,
        status: 'active',
        posterEmail: 'sender@haw-hamburg.de',
        category: 'housing'
    })
    const hidden = await (
        await call('/marketplace/posts?view=hidden', 'mod')
    ).json()
    expect(hidden.items.map((i: { id: string }) => i.id)).toEqual([post1])
    // Search covers title, text and poster email; % and _ are literal.
    for (const [q, ids] of [
        ['zimmer', [post2]],
        ['poster@', [post1]],
        ['100%', [post2]],
        ['_', []]
    ] as const) {
        const r = await (
            await call(`/marketplace/posts?q=${encodeURIComponent(q)}`, 'mod')
        ).json()
        expect(r.items.map((i: { id: string }) => i.id)).toEqual([...ids])
    }
    expect((await call('/marketplace/posts?view=x', 'mod')).status).toBe(400)
    const views = (await auditRows()).filter(
        (r) => r.entity === 'marketplace_identity'
    )
    expect(views.length).toBeGreaterThan(0)
    expect(JSON.stringify(views)).not.toContain('Zimmer')
})

run('post list shows expired and blocked owners as hidden', async () => {
    const post2 = '00000000-0000-4000-8000-000000000002'
    await pool.query(
        `INSERT INTO haw_market_post(id,owner_id,type,category,title,description,status,expires_at)
         VALUES ($1,'sender','offer','jobs','Old','x','active',now()-interval '1 day')`,
        [post2]
    )
    await pool.query("UPDATE haw_market_post SET status='active' WHERE id=$1", [
        post1
    ])
    await pool.query(
        `INSERT INTO haw_market_block(id,user_id,email_hash,reason,until,created_by,created_at)
         VALUES (gen_random_uuid(),'poster','h','spam',now()+interval '1 day','mod',now())`
    )
    const { items } = await (await call('/marketplace/posts', 'mod')).json()
    const status = Object.fromEntries(
        items.map((i: { id: string; status: string }) => [i.id, i.status])
    )
    expect(status).toEqual({ [post1]: 'hiddenByBlock', [post2]: 'expired' })
    expect(
        (await (await call('/marketplace/posts?view=live', 'mod')).json()).items
    ).toHaveLength(0)
})

run('remove a post directly: closes open reports, mails, audits', async () => {
    expect(
        (
            await call(`/marketplace/posts/${post1}/remove`, 'mod', 'POST', {
                reason: 'x'
            })
        ).status
    ).toBe(400)
    const r = await call(`/marketplace/posts/${post1}/remove`, 'mod', 'POST', {
        reason: 'Gegen die Regeln'
    })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, mailSent: true })
    const post = await pool.query(
        'SELECT status FROM haw_market_post WHERE id=$1',
        [post1]
    )
    expect(post.rows[0].status).toBe('removedByModerator')
    const reports = await pool.query(
        'SELECT decision, decision_reason, decided_by FROM haw_market_report ORDER BY id'
    )
    expect(reports.rows).toEqual([
        {
            decision: 'removed',
            decision_reason: 'Gegen die Regeln',
            decided_by: 'mod@haw-hamburg.de'
        },
        {
            decision: 'removed',
            decision_reason: 'Gegen die Regeln',
            decided_by: 'mod@haw-hamburg.de'
        }
    ])
    expect(mails).toHaveLength(1)
    expect(mails[0].to).toBe('poster@haw-hamburg.de')
    expect(
        (await auditRows()).some(
            (a) =>
                a.entity === 'marketplace_post' &&
                a.operation === 'remove' &&
                a.name === post1
        )
    ).toBe(true)
    // Removing twice is a conflict; an unknown post is 404.
    expect(
        (
            await call(`/marketplace/posts/${post1}/remove`, 'mod', 'POST', {
                reason: 'Gegen die Regeln'
            })
        ).status
    ).toBe(409)
    expect(
        (
            await call(
                '/marketplace/posts/00000000-0000-4000-8000-0000000000ff/remove',
                'mod',
                'POST',
                { reason: 'Gegen die Regeln' }
            )
        ).status
    ).toBe(404)
    expect(
        (
            await call(`/marketplace/posts/${post1}/remove`, 'events', 'POST', {
                reason: 'Gegen die Regeln'
            })
        ).status
    ).toBe(403)
})

run('restore undoes only a moderator removal', async () => {
    expect(
        (await call(`/marketplace/posts/${post1}/restore`, 'mod', 'POST'))
            .status
    ).toBe(409)
    await call(`/marketplace/posts/${post1}/remove`, 'mod', 'POST', {
        reason: 'Gegen die Regeln'
    })
    const r = await call(`/marketplace/posts/${post1}/restore`, 'mod', 'POST')
    expect(r.status).toBe(200)
    const post = await pool.query(
        'SELECT status, report_count FROM haw_market_post WHERE id=$1',
        [post1]
    )
    expect(post.rows[0]).toEqual({ status: 'active', report_count: 0 })
    expect(
        (await auditRows()).some(
            (a) => a.entity === 'marketplace_post' && a.operation === 'restore'
        )
    ).toBe(true)
    expect(
        (await call('/marketplace/posts/not-an-id/restore', 'mod', 'POST'))
            .status
    ).toBe(400)
})

run(
    'open report summary counts without reading or auditing identities',
    async () => {
        expect(
            (await call('/marketplace/reports/summary', 'events')).status
        ).toBe(403)
        const r = await call('/marketplace/reports/summary', 'mod')
        expect(r.status).toBe(200)
        const body = await r.json()
        expect(body.open).toBe(2)
        expect(typeof body.oldestAt).toBe('string')
        expect(JSON.stringify(body)).not.toContain('@')
        expect(
            (await auditRows()).filter(
                (a) => a.entity === 'marketplace_identity'
            )
        ).toHaveLength(0)
        await call(`/marketplace/posts/${post1}/remove`, 'mod', 'POST', {
            reason: 'Gegen die Regeln'
        })
        expect(
            await (await call('/marketplace/reports/summary', 'mod')).json()
        ).toEqual({ open: 0, oldestAt: null })
    }
)
