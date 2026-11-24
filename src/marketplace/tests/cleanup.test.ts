import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    spyOn
} from 'bun:test'
import { readFile } from 'node:fs/promises'
import { getMigrations } from 'better-auth/db/migration'
import { Pool } from 'pg'
import { createAccountAuth } from '../../lib/account-auth'
import { runMarketplaceCleanup } from '../cleanup'
import { PhotoRemoveError, type PhotoStorage } from '../photo-storage'

const url = process.env.HAWCONNECT_TEST_DATABASE_URL
const suite = url ? describe : describe.skip
const DAY = 86_400_000
const NOW = new Date('2026-11-13T10:00:00.000Z')
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)

suite('marketplace cleanup (isolated PostgreSQL)', () => {
    const pool = new Pool({ connectionString: url })
    const auth = createAccountAuth({
        pool,
        secret: 'test-only-secret-with-at-least-thirty-two-characters',
        baseURL: 'http://localhost:4000',
        webOrigin: 'http://localhost:3001',
        send: async () => {}
    })
    const removed: string[][] = []
    let failRemove = false
    const storage: PhotoStorage = {
        put: async () => {},
        signedUrl: async () => '',
        remove: async (keys) => {
            if (failRemove) throw new Error('r2 down')
            removed.push(keys)
        }
    }
    const run = () => runMarketplaceCleanup({ pool, storage, now: () => NOW })
    let owner = ''
    const uid = () => crypto.randomUUID()
    const post = async (
        status: string,
        expiresAt: Date,
        updatedAt: Date = NOW
    ) => {
        const id = uid()
        await pool.query(
            `INSERT INTO haw_market_post(id,owner_id,type,category,title,description,status,created_at,updated_at,expires_at)
             VALUES($1,$2,'offer','jobs','t','d',$3,$4,$5,$6)`,
            [id, owner, status, ago(90), updatedAt, expiresAt]
        )
        return id
    }
    const photo = async (postId: string | null, createdAt: Date = NOW) => {
        const id = uid()
        const key = `marketplace/${id}.jpg`
        await pool.query(
            'INSERT INTO haw_market_photo(id,post_id,owner_id,object_key,created_at) VALUES($1,$2,$3,$4,$5)',
            [id, postId, owner, key, createdAt]
        )
        return key
    }
    const exists = async (table: string, id: string) =>
        (await pool.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id]))
            .rowCount === 1
    const queued = async () =>
        (
            await pool.query<{ object_key: string }>(
                'SELECT object_key FROM haw_market_photo_purge ORDER BY object_key'
            )
        ).rows.map((r) => r.object_key)
    const statusOf = async (id: string) =>
        (
            await pool.query('SELECT status FROM haw_market_post WHERE id=$1', [
                id
            ])
        ).rows[0]?.status

    beforeAll(async () => {
        await (await getMigrations(auth.auth.options)).runMigrations()
        await pool.query(
            await readFile(
                new URL('../../db/accounts/marketplace.sql', import.meta.url),
                'utf8'
            )
        )
        owner = `cln-${uid()}`
        await pool.query(
            'INSERT INTO haw_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
            [owner, `${owner}@haw-hamburg.de`]
        )
    })
    beforeEach(async () => {
        removed.length = 0
        failRemove = false
        await pool.query('DELETE FROM haw_market_report')
        await pool.query('DELETE FROM haw_market_block')
        await pool.query('DELETE FROM haw_market_post')
        await pool.query('DELETE FROM haw_market_photo')
        await pool.query('DELETE FROM haw_market_photo_purge')
    })
    afterAll(async () => {
        await pool.query('DELETE FROM haw_user WHERE id=$1', [owner])
        await pool.end()
    })

    it('expires active posts past expires_at only', async () => {
        const past = await post('active', ago(1))
        const future = await post('active', new Date(NOW.getTime() + DAY))
        const result = await run()
        expect(result.expired).toBe(1)
        expect(await statusOf(past)).toBe('expired')
        expect(await statusOf(future)).toBe('active')
    })

    it('expires reserved posts past expires_at, leaves closed ones, and purges closed after grace', async () => {
        const reservedPast = await post('reserved', ago(1))
        const reservedFuture = await post(
            'reserved',
            new Date(NOW.getTime() + DAY)
        )
        const reservedStale = await post('reserved', ago(31))
        const closedPast = await post('closed', ago(1))
        const closedOld = await post('closed', ago(31))
        await run()
        expect(await statusOf(reservedPast)).toBe('expired')
        expect(await statusOf(reservedFuture)).toBe('reserved')
        expect(await exists('haw_market_post', reservedStale)).toBe(false)
        expect(await statusOf(closedPast)).toBe('closed')
        expect(await exists('haw_market_post', closedOld)).toBe(false)
    })

    it('deletes posts 30 days after expiry or last update with R2 photos first', async () => {
        const oldExpired = await post('expired', ago(31))
        const freshExpired = await post('expired', ago(29))
        const oldOwner = await post('removedByOwner', ago(60), ago(31))
        const freshOwner = await post('removedByOwner', ago(20), ago(29))
        const oldMod = await post('removedByModerator', ago(60), ago(31))
        const staleActive = await post('active', ago(31))
        const k1 = await photo(oldExpired)
        const k2 = await photo(oldOwner)
        const kKeep = await photo(freshExpired)
        const result = await run()
        expect(result.deleted).toBe(4)
        expect(result.expired).toBe(1)
        expect(await exists('haw_market_post', oldExpired)).toBe(false)
        expect(await exists('haw_market_post', oldOwner)).toBe(false)
        expect(await exists('haw_market_post', oldMod)).toBe(false)
        expect(await exists('haw_market_post', freshExpired)).toBe(true)
        expect(await exists('haw_market_post', freshOwner)).toBe(true)
        // active but long past expiry: expired, then deleted in the same run
        expect(await exists('haw_market_post', staleActive)).toBe(false)
        expect(removed.flat().sort()).toEqual([k1, k2].sort())
        const left = await pool.query('SELECT object_key FROM haw_market_photo')
        expect(left.rows.map((r) => r.object_key)).toEqual([kKeep])
    })

    it('deletes due posts even when R2 is down and keeps their keys queued until R2 confirms', async () => {
        const old = await post('expired', ago(31))
        const key = await photo(old)
        failRemove = true
        const errors = spyOn(console, 'error').mockImplementation(() => {})
        const first = await run()
        errors.mockRestore()
        expect(first.deleted).toBe(1)
        expect(await exists('haw_market_post', old)).toBe(false)
        expect(await queued()).toEqual([key])
        failRemove = false
        await run()
        expect(removed.flat()).toEqual([key])
        expect(await queued()).toEqual([])
    })

    it('re-checks the purge predicate when deleting, so a post renewed meanwhile survives', async () => {
        const old = await post('expired', ago(31))
        const renewing = new Proxy(pool, {
            get(target, prop, receiver) {
                if (prop !== 'query') return Reflect.get(target, prop, receiver)
                return async (sql: unknown, ...rest: unknown[]) => {
                    if (
                        typeof sql === 'string' &&
                        sql.startsWith('DELETE FROM haw_market_post')
                    )
                        await target.query(
                            "UPDATE haw_market_post SET status='active', expires_at=$2, updated_at=$3 WHERE id=$1",
                            [old, new Date(NOW.getTime() + 30 * DAY), NOW]
                        )
                    return (target.query as (...a: unknown[]) => unknown)(
                        sql,
                        ...rest
                    )
                }
            }
        }) as Pool
        const result = await runMarketplaceCleanup({
            pool: renewing,
            storage,
            now: () => NOW
        })
        expect(result.deleted).toBe(0)
        expect(await statusOf(old)).toBe('active')
    })

    it('queues the photo keys of a deleted account and cleanup removes them from storage', async () => {
        const gone = `cln-del-${uid()}`
        await pool.query(
            'INSERT INTO haw_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
            [gone, `${gone}@haw-hamburg.de`]
        )
        const postId = uid()
        await pool.query(
            `INSERT INTO haw_market_post(id,owner_id,type,category,title,description,status,expires_at)
             VALUES($1,$2,'offer','jobs','t','d','active',$3)`,
            [postId, gone, new Date(NOW.getTime() + DAY)]
        )
        const keys: string[] = []
        for (const postRef of [postId, null]) {
            const id = uid()
            keys.push(`marketplace/${id}.jpg`)
            await pool.query(
                'INSERT INTO haw_market_photo(id,post_id,owner_id,object_key) VALUES($1,$2,$3,$4)',
                [id, postRef, gone, `marketplace/${id}.jpg`]
            )
        }
        await pool.query('DELETE FROM haw_user WHERE id=$1', [gone])
        expect(
            (
                await pool.query(
                    'SELECT 1 FROM haw_market_photo WHERE owner_id=$1',
                    [gone]
                )
            ).rowCount
        ).toBe(0)
        expect(await queued()).toEqual([...keys].sort())

        failRemove = true
        const errors = spyOn(console, 'error').mockImplementation(() => {})
        await run()
        errors.mockRestore()
        expect(await queued()).toEqual([...keys].sort())

        failRemove = false
        await run()
        expect(removed.flat().sort()).toEqual([...keys].sort())
        expect(await queued()).toEqual([])
    })

    it('drains the queue oldest first in chunks and keeps only keys storage did not confirm', async () => {
        const errors = spyOn(console, 'error').mockImplementation(() => {})
        const keys = Array.from(
            { length: 5 },
            (_, i) => `marketplace/00000000-0000-4000-8000-00000000000${i}.jpg`
        )
        // inserted newest first so queue order differs from key order
        for (const [i, key] of [...keys.entries()].reverse())
            await pool.query(
                'INSERT INTO haw_market_photo_purge(object_key, queued_at) VALUES($1,$2)',
                [key, new Date(NOW.getTime() - (10 - i) * 1000)]
            )
        const calls: string[][] = []
        const flaky: PhotoStorage = {
            ...storage,
            remove: async (chunk) => {
                calls.push(chunk)
                // the oldest key fails permanently; the whole second chunk fails once
                if (calls.length === 2) throw new Error('r2 down')
                const failed = chunk.filter((k) => k === keys[0])
                if (failed.length) throw new PhotoRemoveError(failed)
            }
        }
        await runMarketplaceCleanup(
            { pool, storage: flaky, now: () => NOW },
            { chunkSize: 2 }
        )
        errors.mockRestore()
        // oldest first, every chunk tried exactly once despite the failures
        expect(calls).toEqual([
            [keys[0], keys[1]],
            [keys[2], keys[3]],
            [keys[4]]
        ])
        expect(await queued()).toEqual([keys[0], keys[2], keys[3]])
    })

    it('deletes undecided hidden posts 30 days after expiry', async () => {
        const old = await post('hiddenPendingReview', ago(31))
        const fresh = await post('hiddenPendingReview', ago(29))
        await run()
        expect(await exists('haw_market_post', old)).toBe(false)
        expect(await exists('haw_market_post', fresh)).toBe(true)
    })

    it('keeps running other rules when one fails', async () => {
        const errors = spyOn(console, 'error').mockImplementation(() => {})
        const old = await post('expired', ago(31))
        const broken = new Proxy(pool, {
            get(target, prop, receiver) {
                if (prop !== 'query') return Reflect.get(target, prop, receiver)
                return (sql: unknown, ...rest: unknown[]) =>
                    typeof sql === 'string' &&
                    sql.includes('haw_market_message')
                        ? Promise.reject(new Error('boom'))
                        : (target.query as (...a: unknown[]) => unknown)(
                              sql,
                              ...rest
                          )
            }
        }) as Pool
        const result = await runMarketplaceCleanup({
            pool: broken,
            storage,
            now: () => NOW
        })
        expect(errors).toHaveBeenCalledTimes(1)
        errors.mockRestore()
        expect(result.deleted).toBe(1)
        expect(await exists('haw_market_post', old)).toBe(false)
    })

    it('removes unattached photos older than 24 hours', async () => {
        const oldKey = await photo(null, new Date(NOW.getTime() - 25 * 3600e3))
        const newKey = await photo(null, new Date(NOW.getTime() - 3600e3))
        await run()
        expect(removed.flat()).toEqual([oldKey])
        const left = await pool.query('SELECT object_key FROM haw_market_photo')
        expect(left.rows.map((r) => r.object_key)).toEqual([newKey])
    })

    it('keeps the keys of deleted unattached photos queued when R2 removal fails', async () => {
        const key = await photo(null, ago(2))
        failRemove = true
        const errors = spyOn(console, 'error').mockImplementation(() => {})
        await run()
        errors.mockRestore()
        expect(
            (await pool.query('SELECT 1 FROM haw_market_photo')).rowCount
        ).toBe(0)
        expect(await queued()).toEqual([key])
    })

    it('deletes messages older than 30 days', async () => {
        const p = await post('active', new Date(NOW.getTime() + DAY))
        const mk = async (days: number) => {
            const id = uid()
            await pool.query(
                `INSERT INTO haw_market_message(id,post_id,sender_id,recipient_id,body,report_token,created_at)
                 VALUES($1,$2,$3,$3,'hi',$4,$5)`,
                [id, p, owner, uid(), ago(days)]
            )
            return id
        }
        const oldMsg = await mk(31)
        const newMsg = await mk(29)
        await run()
        expect(await exists('haw_market_message', oldMsg)).toBe(false)
        expect(await exists('haw_market_message', newMsg)).toBe(true)
    })

    it('deletes reports after a year and drops snapshots of deleted posts', async () => {
        const live = await post('active', new Date(NOW.getTime() + DAY))
        const mk = async (postId: string | null, days: number) => {
            const id = uid()
            await pool.query(
                `INSERT INTO haw_market_report(id,kind,post_id,reporter_id,reason,snapshot,created_at)
                 VALUES($1,'post',$2,$3,'spam','{"title":"x"}',$4)`,
                [id, postId, days > 100 ? owner : null, ago(days)]
            )
            return id
        }
        const oldReport = await mk(live, 366)
        const orphan = await mk(null, 10)
        const withPost = await mk(live, 10)
        const decide =
            "UPDATE haw_market_report SET decided_at=$2, decision='removed', decision_reason='Scam listing' WHERE id=$1"
        await pool.query(decide, [oldReport, ago(300)])
        await pool.query(decide, [withPost, ago(5)])
        await run()
        // the year purge drops the whole report, the moderator's reason with it
        expect(await exists('haw_market_report', oldReport)).toBe(false)
        expect(
            (
                await pool.query(
                    'SELECT decision_reason FROM haw_market_report WHERE id=$1',
                    [withPost]
                )
            ).rows[0].decision_reason
        ).toBe('Scam listing')
        const snap = async (id: string) =>
            (
                await pool.query(
                    'SELECT snapshot FROM haw_market_report WHERE id=$1',
                    [id]
                )
            ).rows[0].snapshot
        expect(await snap(orphan)).toBeNull()
        expect(await snap(withPost)).toEqual({ title: 'x' })
    })

    it('lifts ended blocks and clears the email hash', async () => {
        const mk = async (until: Date, lifted: Date | null = null) => {
            const id = uid()
            await pool.query(
                "INSERT INTO haw_market_block(id,user_id,email_hash,reason,until,created_by,lifted_at) VALUES($1,$2,'hash','spam',$3,'mod',$4)",
                [id, owner, until, lifted]
            )
            return id
        }
        const ended = await mk(ago(1))
        const active = await mk(new Date(NOW.getTime() + DAY))
        const row = async (id: string) =>
            (
                await pool.query(
                    'SELECT email_hash, lifted_at FROM haw_market_block WHERE id=$1',
                    [id]
                )
            ).rows[0]
        await run()
        const e = await row(ended)
        expect(e.email_hash).toBe('')
        expect(e.lifted_at.getTime()).toBe(NOW.getTime())
        const a = await row(active)
        expect(a.email_hash).toBe('hash')
        expect(a.lifted_at).toBeNull()
    })
})
