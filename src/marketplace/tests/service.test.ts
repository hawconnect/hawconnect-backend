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
import type { TransactionalMail } from '../../lib/account-mail'
import { blockHash } from '../block-hash'
import type { PhotoStorage } from '../photo-storage'
import { createMarketplace } from '../service'
import { MARKET, type MarketPostInput } from '../validation'

const jobDetails = {
    employer: 'Acme GmbH',
    jobType: 'partTime',
    workMode: 'hybrid',
    languages: ['english', 'german'],
    weeklyHours: 12,
    applyMethod: 'url',
    applyUrl: 'https://acme.example/jobs/1'
}

const url = process.env.HAWCONNECT_TEST_DATABASE_URL
const suite = url ? describe : describe.skip
const DAY = 86_400_000
const SECRET = 'test-block-secret'
const START = new Date('2026-11-13T10:00:00.000Z')

suite('marketplace service (isolated PostgreSQL)', () => {
    const pool = new Pool({ connectionString: url })
    const auth = createAccountAuth({
        pool,
        secret: 'test-only-secret-with-at-least-thirty-two-characters',
        baseURL: 'http://localhost:4000',
        webOrigin: 'http://localhost:3001',
        send: async () => {}
    })
    let clock = START
    const later = (days: number) => {
        clock = new Date(clock.getTime() + days * DAY)
    }
    const mails: TransactionalMail[] = []
    const removed: string[][] = []
    const storage: PhotoStorage = {
        put: async () => {},
        signedUrl: async (key, seconds) => `https://signed/${key}?s=${seconds}`,
        remove: async (keys) => {
            removed.push(keys)
        }
    }
    const deps = {
        pool,
        storage,
        send: async (m: TransactionalMail) => {
            mails.push(m)
        },
        now: () => clock,
        blockSecret: SECRET,
        webOrigin: 'https://hawconnect.test'
    }
    const market = createMarketplace(deps)
    const users: string[] = []
    const blocks: string[] = []
    const email = (id: string) => `${id}@haw-hamburg.de`
    const user = async (rules = true, id = `mkt-${crypto.randomUUID()}`) => {
        await pool.query(
            'INSERT INTO haw_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
            [id, email(id)]
        )
        users.push(id)
        if (rules) await market.acceptRules(id, MARKET.rulesVersion)
        return id
    }
    const input = (over: Partial<MarketPostInput> = {}) => ({
        type: 'offer' as const,
        category: 'housing' as const,
        title: 'Room in Barmbek',
        description: 'A bright room, close to campus.',
        priceEur: 450,
        priceFree: false,
        priceUnit: null,
        location: 'Barmbek',
        availableFrom: '2026-12-01',
        details: {
            housingType: 'privateRoom',
            rentalDuration: 'long'
        } as MarketPostInput['details'],
        ...over
    })
    const photo = async (owner: string) => {
        const id = crypto.randomUUID()
        await pool.query(
            'INSERT INTO haw_market_photo(id,owner_id,object_key) VALUES($1,$2,$3)',
            [id, owner, `marketplace/${id}.jpg`]
        )
        return id
    }
    const status = async (id: string) =>
        (
            await pool.query('SELECT status FROM haw_market_post WHERE id=$1', [
                id
            ])
        ).rows[0]?.status
    const block = async (userId: string | null, mail: string, days = 30) => {
        const id = crypto.randomUUID()
        await pool.query(
            "INSERT INTO haw_market_block(id,user_id,email_hash,reason,until,created_by) VALUES($1,$2,$3,'spam',$4,'mod')",
            [
                id,
                userId,
                blockHash(mail, SECRET),
                new Date(clock.getTime() + days * DAY)
            ]
        )
        blocks.push(id)
        return id
    }

    beforeAll(async () => {
        await (await getMigrations(auth.auth.options)).runMigrations()
        await pool.query(
            await readFile(
                new URL('../../db/accounts/marketplace.sql', import.meta.url),
                'utf8'
            )
        )
    })
    beforeEach(() => {
        clock = START
        mails.length = 0
        removed.length = 0
    })
    afterAll(async () => {
        await pool.query('DELETE FROM haw_market_block WHERE id = ANY($1)', [
            blocks
        ])
        await pool.query(
            'DELETE FROM haw_market_report WHERE reporter_id = ANY($1)',
            [users]
        )
        await pool.query('DELETE FROM haw_user WHERE id = ANY($1)', [users])
        await pool.end()
    })

    it('requires sign-in and accepted rules to post', async () => {
        const u = await user(false)
        await expect(market.create('', input())).rejects.toThrow(
            'SignInRequired'
        )
        expect(await market.rulesAccepted(u)).toBe(false)
        await expect(market.create(u, input())).rejects.toThrow('RulesRequired')
        await expect(market.acceptRules(u, 0)).rejects.toThrow('RulesRequired')
        await market.acceptRules(u, MARKET.rulesVersion)
        expect(await market.rulesAccepted(u)).toBe(true)
        const post = await market.create(u, input())
        expect(post.status).toBe('active')
        expect(post.isOwn).toBe(true)
        expect(new Date(post.expiresAt).getTime()).toBe(
            START.getTime() + 30 * DAY
        )
        await expect(market.create(u, input({ title: 'x' }))).rejects.toThrow(
            'InvalidMarketPost:title'
        )
    })

    it('shows posts from every kind of mailbox the same way', async () => {
        const haw = await user()
        const guest = await user()
        await pool.query('UPDATE haw_user SET email = $2 WHERE id = $1', [
            guest,
            `${guest}@mail.example.org`
        ])
        const viewer = await user()
        const a = await market.create(haw, input())
        const b = await market.create(guest, input())
        const fromHaw = await market.get(viewer, a.id)
        const seen = await market.get(viewer, b.id)
        expect(Object.keys(seen ?? {}).sort()).toEqual(
            Object.keys(fromHaw ?? {}).sort()
        )
        expect('hawVerified' in (seen ?? {})).toBe(false)
        expect(JSON.stringify(seen)).not.toContain('example.org')
    })
    it('limits an account to five active posts', async () => {
        const u = await user()
        for (let i = 0; i < 5; i++) await market.create(u, input())
        await expect(market.create(u, input())).rejects.toThrow(
            'ActivePostLimit'
        )
    })

    it('lets exactly one of two concurrent creates at four active succeed', async () => {
        const u = await user()
        for (let i = 0; i < 4; i++) await market.create(u, input())
        // Widen the race window: pause each transaction after it counts active posts.
        const slowPool = {
            query: pool.query.bind(pool),
            connect: async () => {
                const client = await pool.connect()
                const query = client.query.bind(client) as (
                    ...a: unknown[]
                ) => Promise<unknown>
                return Object.assign(client, {
                    query: async (...a: unknown[]) => {
                        const result = await query(...a)
                        if (String(a[0]).includes('AS n FROM haw_market_post'))
                            await Bun.sleep(100)
                        return result
                    }
                })
            }
        } as unknown as Pool
        const racing = createMarketplace({ ...deps, pool: slowPool })
        const results = await Promise.allSettled([
            racing.create(u, input()),
            racing.create(u, input())
        ])
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
        const rejected = results.find((r) => r.status === 'rejected')
        expect((rejected as PromiseRejectedResult).reason.message).toBe(
            'ActivePostLimit'
        )
    })

    it('lists active posts without owner identity, newest first, paged', async () => {
        const owner = await user()
        const viewer = await user()
        const p1 = await photo(owner)
        const p2 = await photo(owner)
        const first = await market.create(
            owner,
            input({
                category: 'jobs',
                type: 'request',
                priceUnit: 'perHour',
                details: { jobType: 'partTime', languages: ['english'] }
            })
        )
        later(0.001)
        const second = await market.create(owner, {
            ...input({
                category: 'jobs',
                type: 'request',
                priceUnit: 'perHour',
                details: { jobType: 'partTime', languages: ['english'] }
            }),
            photoIds: [p2, p1]
        })
        expect(second.photoUrls).toEqual([
            `https://signed/marketplace/${p2}.jpg?s=3600`,
            `https://signed/marketplace/${p1}.jpg?s=3600`
        ])
        const page = await market.list(viewer, {
            category: 'jobs',
            limit: 1
        })
        expect(page.posts.map((p) => p.id)).toEqual([second.id])
        expect(page.posts[0].isOwn).toBe(false)
        expect(page.nextCursor).toBeString()
        const next = await market.list(viewer, {
            category: 'jobs',
            limit: 1,
            cursor: page.nextCursor as string
        })
        expect(next.posts.map((p) => p.id)).toEqual([first.id])
        const all = await market.list(viewer, { limit: 100 })
        expect(all.posts.length).toBeLessThanOrEqual(30)
        const keys = JSON.stringify(all.posts)
        expect(keys).not.toContain('owner')
        expect(keys).not.toContain(email(owner))
        expect(keys).not.toContain(owner)
        for (const p of all.posts) expect(p.status).toBe('active')
        // Guests may browse; they never own a post and still see no identity.
        const guest = await market.list('', {})
        expect(guest.posts.length).toBe(all.posts.length)
        for (const p of guest.posts) expect(p.isOwn).toBe(false)
        expect(JSON.stringify(guest.posts)).not.toContain(owner)
        const seen = guest.posts[0]
        expect((await market.get('', seen.id))?.id).toBe(seen.id)
    })

    it('hides expired posts from others, renews within 30 days after expiry', async () => {
        const owner = await user()
        const viewer = await user()
        const post = await market.create(owner, input())
        later(31)
        expect(await market.get(viewer, post.id)).toBeNull()
        expect((await market.get(owner, post.id))?.status).toBe('expired')
        expect(
            (await market.list(viewer, { limit: 30 })).posts.some(
                (p) => p.id === post.id
            )
        ).toBe(false)
        const renewed = await market.renew(owner, post.id)
        expect(renewed.status).toBe('active')
        expect(new Date(renewed.expiresAt).getTime()).toBe(
            clock.getTime() + 30 * DAY
        )
        later(30 + 31)
        await expect(market.renew(owner, post.id)).rejects.toThrow(
            'RenewWindowClosed'
        )
        await expect(market.renew(viewer, post.id)).rejects.toThrow(
            'PostUnavailable'
        )
    })

    it('keeps expiry on edit and replaces photos, deleting detached ones', async () => {
        const owner = await user()
        const other = await user()
        const a = await photo(owner)
        const b = await photo(owner)
        const c = await photo(owner)
        const foreign = await photo(other)
        const post = await market.create(owner, {
            ...input(),
            photoIds: [a, b]
        })
        later(3)
        const edited = await market.update(owner, post.id, {
            ...input({ title: 'Desk, now cheaper', priceEur: 10 }),
            photoIds: [c, a]
        })
        expect(edited.title).toBe('Desk, now cheaper')
        expect(edited.expiresAt).toBe(post.expiresAt)
        expect(edited.photoUrls).toEqual([
            `https://signed/marketplace/${c}.jpg?s=3600`,
            `https://signed/marketplace/${a}.jpg?s=3600`
        ])
        expect(removed).toEqual([[`marketplace/${b}.jpg`]])
        expect(
            (
                await pool.query('SELECT 1 FROM haw_market_photo WHERE id=$1', [
                    b
                ])
            ).rowCount
        ).toBe(0)
        await expect(
            market.update(owner, post.id, { ...input(), photoIds: [foreign] })
        ).rejects.toThrow('InvalidMarketPost:photoIds')
        await expect(market.update(other, post.id, input())).rejects.toThrow(
            'PostUnavailable'
        )
    })

    it('queues a detached photo for purge and drops it from the queue only once storage confirms', async () => {
        const owner = await user()
        const a = await photo(owner)
        const b = await photo(owner)
        const post = await market.create(owner, {
            ...input(),
            photoIds: [a, b]
        })
        const inQueue = async (id: string) =>
            (
                await pool.query(
                    'SELECT 1 FROM haw_market_photo_purge WHERE object_key=$1',
                    [`marketplace/${id}.jpg`]
                )
            ).rowCount
        await market.update(owner, post.id, { ...input(), photoIds: [a] })
        expect(removed).toEqual([[`marketplace/${b}.jpg`]])
        expect(await inQueue(b)).toBe(0)

        const failing = createMarketplace({
            ...deps,
            storage: {
                ...storage,
                remove: async () => {
                    throw new Error('r2 down')
                }
            }
        })
        const errors = spyOn(console, 'error').mockImplementation(() => {})
        await failing.update(owner, post.id, { ...input(), photoIds: [] })
        errors.mockRestore()
        expect(await inQueue(a)).toBe(1)
        await pool.query(
            'DELETE FROM haw_market_photo_purge WHERE object_key=$1',
            [`marketplace/${a}.jpg`]
        )
    })

    it('removes a post for everyone, including the owner', async () => {
        const owner = await user()
        const viewer = await user()
        const post = await market.create(owner, input())
        await market.remove(owner, post.id)
        expect(await status(post.id)).toBe('removedByOwner')
        expect(await market.get(owner, post.id)).toBeNull()
        expect(await market.get(viewer, post.id)).toBeNull()
        expect((await market.mine(owner)).map((p) => p.id)).not.toContain(
            post.id
        )
        await expect(market.remove(owner, post.id)).rejects.toThrow(
            'PostUnavailable'
        )
    })

    it('auto-hides a post after three distinct reports', async () => {
        const owner = await user()
        const post = await market.create(owner, input())
        const r1 = await user()
        await market.report(r1, post.id, { reason: 'scam', note: 'fishy' })
        await expect(
            market.report(r1, post.id, { reason: 'spam' })
        ).rejects.toThrow('AlreadyReported')
        await expect(
            market.report(owner, post.id, { reason: 'spam' })
        ).rejects.toThrow('OwnPost')
        await market.report(await user(), post.id, { reason: 'spam' })
        expect(await status(post.id)).toBe('active')
        await market.report(await user(), post.id, { reason: 'illegal' })
        expect(await status(post.id)).toBe('hiddenPendingReview')
        const snap = await pool.query(
            'SELECT snapshot, report_count FROM haw_market_report r JOIN haw_market_post p ON p.id = r.post_id WHERE r.post_id=$1 AND r.reporter_id=$2',
            [post.id, r1]
        )
        expect(snap.rows[0].snapshot).toEqual({
            title: post.title,
            description: post.description,
            category: post.category,
            details: post.details
        })
        expect(snap.rows[0].report_count).toBe(3)
        expect(await market.get(r1, post.id)).toBeNull()
        expect((await market.mine(owner))[0].status).toBe('hiddenPendingReview')
    })

    it('emails the owner with Reply-To sender and enforces contact limits', async () => {
        const owner = await user()
        const sender = await user(false)
        const post = await market.create(owner, input())
        await expect(
            market.contact(owner, post.id, 'Hello, is it still there?')
        ).rejects.toThrow('OwnPost')
        await market.contact(sender, post.id, 'Hello, is it still there?')
        expect(mails).toHaveLength(1)
        expect(mails[0].to).toBe(email(owner))
        expect(mails[0].replyTo).toBe(email(sender))
        const row = await pool.query(
            'SELECT report_token, recipient_id FROM haw_market_message WHERE post_id=$1',
            [post.id]
        )
        expect(row.rows[0].recipient_id).toBe(owner)
        expect(row.rows[0].report_token).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(mails[0].text).toContain(
            `https://hawconnect.test/marketplace/report/${row.rows[0].report_token}`
        )
        expect(mails[0].text).not.toContain(email(sender))
        await expect(
            market.contact(sender, post.id, 'Hello again, any news?')
        ).rejects.toThrow('ContactLimit')
        later(1.01)
        await market.contact(sender, post.id, 'Hello again, any news?')
        expect(mails).toHaveLength(2)
    })

    it('caps a sender at 20 contact messages per 24 hours', async () => {
        const sender = await user()
        const owners = [
            await user(),
            await user(),
            await user(),
            await user(),
            await user()
        ]
        const posts: string[] = []
        for (const o of owners)
            for (let i = 0; i < 5; i++)
                posts.push((await market.create(o, input())).id)
        for (let i = 0; i < 20; i++)
            await market.contact(sender, posts[i], 'Message number one!')
        await expect(
            market.contact(sender, posts[20], 'Message number one!')
        ).rejects.toThrow('ContactLimit')
        expect(mails).toHaveLength(20)
    })

    it('refuses contact when the owner is blocked or deleted, without mail', async () => {
        const owner = await user()
        const gone = await user()
        const sender = await user()
        const post = await market.create(owner, input())
        const goneId = (await market.create(gone, input())).id
        await block(owner, email(owner))
        await expect(
            market.contact(sender, post.id, 'Hello, is it still there?')
        ).rejects.toThrow('PostUnavailable')
        await pool.query('DELETE FROM haw_user WHERE id=$1', [gone])
        await expect(
            market.contact(sender, goneId, 'Hello, is it still there?')
        ).rejects.toThrow('PostUnavailable')
        expect(mails).toHaveLength(0)
    })

    it('removes the message and frees the slot when sending fails', async () => {
        const owner = await user()
        const sender = await user()
        const post = await market.create(owner, input())
        const rows = async () =>
            (
                await pool.query(
                    'SELECT report_token FROM haw_market_message WHERE post_id=$1',
                    [post.id]
                )
            ).rows
        let failNext = true
        const committedAtSend: number[] = []
        const flaky = createMarketplace({
            ...deps,
            send: async (m: TransactionalMail) => {
                // Another connection must already see the row: no transaction is open during SMTP.
                committedAtSend.push((await rows()).length)
                if (failNext) {
                    failNext = false
                    throw new Error('smtp timeout')
                }
                mails.push(m)
            }
        })
        await expect(
            flaky.contact(sender, post.id, 'Hello, is it still there?')
        ).rejects.toThrow('MailUnavailable')
        expect(await rows()).toHaveLength(0)
        expect(mails).toHaveLength(0)
        await flaky.contact(sender, post.id, 'Hello, is it still there?')
        const stored = await rows()
        expect(stored).toHaveLength(1)
        expect(committedAtSend).toEqual([1, 1])
        expect(mails).toHaveLength(1)
        expect(mails[0].text).toContain(
            `/marketplace/report/${stored[0].report_token}`
        )
    })

    it('reports MailUnavailable without a mailer', async () => {
        const owner = await user()
        const sender = await user()
        const post = await market.create(owner, input())
        const noMail = createMarketplace({ ...deps, send: undefined })
        await expect(
            noMail.contact(sender, post.id, 'Hello, is it still there?')
        ).rejects.toThrow('MailUnavailable')
        expect(
            (
                await pool.query(
                    'SELECT 1 FROM haw_market_message WHERE post_id=$1',
                    [post.id]
                )
            ).rowCount
        ).toBe(0)
    })

    it('lets only the recipient report a message, within 30 days', async () => {
        const owner = await user()
        const sender = await user()
        const post = await market.create(owner, input())
        await market.contact(sender, post.id, 'Send me your bank details!')
        const token = (
            await pool.query(
                'SELECT report_token FROM haw_market_message WHERE post_id=$1',
                [post.id]
            )
        ).rows[0].report_token
        await expect(
            market.reportMessage(sender, token, { reason: 'scam' })
        ).rejects.toThrow('PostUnavailable')
        await expect(
            market.reportMessage(owner, 'nope', { reason: 'scam' })
        ).rejects.toThrow('PostUnavailable')
        await market.reportMessage(owner, token, { reason: 'scam' })
        await expect(
            market.reportMessage(owner, token, { reason: 'scam' })
        ).rejects.toThrow('AlreadyReported')
        const snap = await pool.query(
            'SELECT snapshot FROM haw_market_report WHERE reporter_id=$1 AND message_id IS NOT NULL',
            [owner]
        )
        expect(snap.rows[0].snapshot).toEqual({
            body: 'Send me your bank details!',
            postTitle: post.title
        })
        expect(await status(post.id)).toBe('active')
        later(31)
        await expect(
            market.reportMessage(owner, token, { reason: 'spam' })
        ).rejects.toThrow('PostUnavailable')
    })

    it('applies email-hash blocks to existing and fresh accounts', async () => {
        const x = await user()
        const viewer = await user()
        const post = await market.create(x, input())
        await block(null, ` ${email(x).toUpperCase()} `)
        expect(await market.isBlocked(x)).toBe(true)
        // Hiding is derived at read time; the stored status is untouched.
        expect(await status(post.id)).toBe('active')
        expect(await market.get(viewer, post.id)).toBeNull()
        expect((await market.get(x, post.id))?.status).toBe('hiddenByBlock')
        await expect(market.create(x, input())).rejects.toThrow('Blocked')
        await expect(
            market.contact(
                x,
                (await market.create(viewer, input())).id,
                'Hello there, still available?'
            )
        ).rejects.toThrow('Blocked')
        expect((await market.list(x, {})).posts).toBeArray()

        await pool.query('DELETE FROM haw_user WHERE id=$1', [x])
        const fresh = `${x}`
        await pool.query(
            'INSERT INTO haw_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
            [`${fresh}-new`, email(x)]
        )
        users.push(`${fresh}-new`)
        await market.acceptRules(`${fresh}-new`, MARKET.rulesVersion)
        expect(await market.isBlocked(`${fresh}-new`)).toBe(true)
        await expect(market.create(`${fresh}-new`, input())).rejects.toThrow(
            'Blocked'
        )
    })

    it('create and get round-trip details', async () => {
        const owner = await user()
        const created = await market.create(
            owner,
            input({
                category: 'jobs',
                priceEur: 15,
                priceUnit: 'perHour',
                location: 'Hamburg',
                details: jobDetails
            })
        )
        expect(created.details).toEqual(jobDetails)
        expect((await market.get(owner, created.id))?.details).toEqual(
            jobDetails
        )
        expect(created).not.toHaveProperty('campus')
    })

    it('update replaces details', async () => {
        const owner = await user()
        const housing = await market.create(
            owner,
            input({
                category: 'housing',
                priceEur: 500,
                priceUnit: 'perMonth',
                location: 'Barmbek',
                details: {
                    housingType: 'studio',
                    rentalDuration: 'long',
                    deposit: 1000,
                    facilities: ['kitchen']
                }
            })
        )
        expect(housing.details.deposit).toBe(1000)
        const updated = await market.update(
            owner,
            housing.id,
            input({
                category: 'jobs',
                type: 'request',
                priceEur: 20,
                priceUnit: 'perHour',
                details: { jobType: 'partTime', languages: ['english'] }
            })
        )
        expect(updated.details).toEqual({
            jobType: 'partTime',
            languages: ['english']
        })
        expect((await market.get(owner, housing.id))?.details).toEqual({
            jobType: 'partTime',
            languages: ['english']
        })
    })

    it('list ignores a campus filter argument (no longer supported)', async () => {
        const viewer = await user()
        const page = await market.list(viewer, {
            campus: 'finkenau'
        } as never)
        expect(Array.isArray(page.posts)).toBe(true)
    })

    it("hides a blocked user's posts only while the block is current", async () => {
        const owner = await user()
        const viewer = await user()
        const post = await market.create(
            owner,
            input({ category: 'jobs', details: jobDetails })
        )
        const listed = async () =>
            (
                await market.list(viewer, { category: 'jobs', limit: 30 })
            ).posts.some((p) => p.id === post.id)
        const blockId = await block(owner, email(owner), 2)
        expect(await market.isBlocked(owner)).toBe(true)
        await expect(market.renew(owner, post.id)).rejects.toThrow('Blocked')
        expect(await market.get(viewer, post.id)).toBeNull()
        expect(await listed()).toBe(false)
        expect((await market.get(owner, post.id))?.status).toBe('hiddenByBlock')
        later(3)
        expect((await market.get(viewer, post.id))?.status).toBe('active')
        expect(await listed()).toBe(true)
        const lifted = await block(owner, email(owner))
        expect(await market.get(viewer, post.id)).toBeNull()
        await pool.query(
            'UPDATE haw_market_block SET lifted_at=$2 WHERE id=$1',
            [lifted, clock]
        )
        expect((await market.get(viewer, post.id))?.status).toBe('active')
        expect(await listed()).toBe(true)
        expect(await market.renew(owner, post.id)).toBeTruthy()
        expect(blockId).toBeString()
    })

    it('ignores lifted and ended blocks', async () => {
        const u = await user()
        const id = await block(u, email(u), 2)
        expect(await market.isBlocked(u)).toBe(true)
        later(3)
        expect(await market.isBlocked(u)).toBe(false)
        const second = await block(u, email(u))
        await pool.query(
            'UPDATE haw_market_block SET lifted_at=$2 WHERE id=$1',
            [second, clock]
        )
        expect(await market.isBlocked(u)).toBe(false)
        expect(id).toBeString()
    })

    describe('owner status', () => {
        const housing = () =>
            input({
                category: 'housing',
                details: {
                    housingType: 'studio',
                    rentalDuration: 'long'
                } as MarketPostInput['details']
            })

        it('owner marks a housing listing reserved and it stays public with status reserved', async () => {
            const owner = await user()
            const viewer = await user()
            const post = await market.create(owner, housing())
            const r = await market.setStatus(owner, post.id, 'reserved')
            expect(r.status).toBe('reserved')
            expect((await market.get(viewer, post.id))?.status).toBe('reserved')
            expect(
                (await market.setStatus(owner, post.id, 'reserved')).status
            ).toBe('reserved')
            expect(
                (await market.setStatus(owner, post.id, 'active')).status
            ).toBe('active')
        })

        it('reserved is refused for jobs', async () => {
            const owner = await user()
            const post = await market.create(
                owner,
                input({
                    category: 'jobs',
                    details: jobDetails as MarketPostInput['details']
                })
            )
            await expect(
                market.setStatus(owner, post.id, 'reserved')
            ).rejects.toThrow('InvalidMarketStatus')
        })

        it('closed hides the listing from others and keeps it in myPosts', async () => {
            const owner = await user()
            const viewer = await user()
            const post = await market.create(owner, input())
            expect(
                (await market.setStatus(owner, post.id, 'closed')).status
            ).toBe('closed')
            expect(await market.get(viewer, post.id)).toBeNull()
            expect(
                (await market.list(viewer, { limit: 30 })).posts.some(
                    (p) => p.id === post.id
                )
            ).toBe(false)
            expect((await market.mine(owner))[0].status).toBe('closed')
            await expect(
                market.setStatus(owner, post.id, 'reserved')
            ).rejects.toThrow('InvalidMarketStatus')
            expect(
                (await market.setStatus(owner, post.id, 'active')).status
            ).toBe('active')
        })

        it('reopening a closed listing counts against the limit', async () => {
            const owner = await user()
            const closed = await market.create(owner, input())
            await market.setStatus(owner, closed.id, 'closed')
            for (let i = 0; i < 5; i++) await market.create(owner, input())
            await expect(
                market.setStatus(owner, closed.id, 'active')
            ).rejects.toThrow('ActivePostLimit')
        })

        it('counts reserved listings against the limit and refuses reopening an expired one', async () => {
            const owner = await user()
            const first = await market.create(owner, housing())
            await market.setStatus(owner, first.id, 'reserved')
            for (let i = 0; i < 4; i++) await market.create(owner, input())
            await expect(market.create(owner, input())).rejects.toThrow(
                'ActivePostLimit'
            )
            const other = await user()
            const post = await market.create(other, input())
            await market.setStatus(other, post.id, 'closed')
            later(31)
            await expect(
                market.setStatus(other, post.id, 'active')
            ).rejects.toThrow('MarketPostExpired')
        })

        it('a reserved listing past expires_at shows as expired and is not public', async () => {
            const owner = await user()
            const viewer = await user()
            const post = await market.create(owner, housing())
            await market.setStatus(owner, post.id, 'reserved')
            later(31)
            expect(await market.get(viewer, post.id)).toBeNull()
            expect((await market.get(owner, post.id))?.status).toBe('expired')
            await expect(
                market.setStatus(owner, post.id, 'closed')
            ).rejects.toThrow('InvalidMarketStatus')
            expect((await market.renew(owner, post.id)).status).toBe('active')
        })

        it('renew keeps reserved when not expired', async () => {
            const owner = await user()
            const post = await market.create(owner, housing())
            await market.setStatus(owner, post.id, 'reserved')
            later(5)
            const r = await market.renew(owner, post.id)
            expect(r.status).toBe('reserved')
            expect(new Date(r.expiresAt).getTime()).toBe(
                clock.getTime() + 30 * DAY
            )
        })

        it('a reserved listing reported 3 times is hidden; the moderator restore makes it active', async () => {
            const owner = await user()
            const post = await market.create(owner, housing())
            await market.setStatus(owner, post.id, 'reserved')
            for (let i = 0; i < 3; i++)
                await market.report(await user(), post.id, { reason: 'spam' })
            expect(await status(post.id)).toBe('hiddenPendingReview')
            await expect(
                market.setStatus(owner, post.id, 'closed')
            ).rejects.toThrow('PostUnavailable')
            // same statement as the admin dismiss action in src/admin/marketplace.ts
            await pool.query(
                "UPDATE haw_market_post SET report_count=0, status=CASE WHEN status='hiddenPendingReview' THEN 'active' ELSE status END WHERE id=$1",
                [post.id]
            )
            expect((await market.get(owner, post.id))?.status).toBe('active')
        })

        it('someone else cannot change the status', async () => {
            const owner = await user()
            const other = await user()
            const post = await market.create(owner, input())
            await expect(
                market.setStatus(other, post.id, 'closed')
            ).rejects.toThrow('PostUnavailable')
            expect(await status(post.id)).toBe('active')
        })

        it('editing is allowed while reserved, refused while closed', async () => {
            const owner = await user()
            const post = await market.create(owner, housing())
            await market.setStatus(owner, post.id, 'reserved')
            const edited = await market.update(owner, post.id, {
                ...housing(),
                title: 'New title'
            })
            expect(edited.title).toBe('New title')
            expect(edited.status).toBe('reserved')
            await market.setStatus(owner, post.id, 'closed')
            await expect(
                market.update(owner, post.id, { ...housing(), title: 'Again' })
            ).rejects.toThrow('PostUnavailable')
        })
    })
})
