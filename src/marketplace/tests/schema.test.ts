import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readdir, readFile } from 'node:fs/promises'
import { getMigrations } from 'better-auth/db/migration'
import { buildSchema, type GraphQLObjectType, isInputObjectType } from 'graphql'
import { Pool } from 'pg'
import { createAccountAuth } from '../../lib/account-auth'
import { MARKET_FIELDS } from '../validation'

const url = process.env.HAWCONNECT_TEST_DATABASE_URL
const suite = url ? describe : describe.skip
suite('marketplace schema (isolated PostgreSQL)', () => {
    const pool = new Pool({ connectionString: url })
    const auth = createAccountAuth({
        pool,
        secret: 'test-only-secret-with-at-least-thirty-two-characters',
        baseURL: 'http://localhost:4000',
        webOrigin: 'http://localhost:3001',
        send: async () => {}
    })
    const owner = `mkt-owner-${crypto.randomUUID()}`
    const other = `mkt-other-${crypto.randomUUID()}`
    const sql = () =>
        readFile(
            new URL('../../db/accounts/marketplace.sql', import.meta.url),
            'utf8'
        )
    beforeAll(async () => {
        await (await getMigrations(auth.auth.options)).runMigrations()
        const script = await sql()
        await pool.query(script)
        await pool.query(script)
        for (const id of [owner, other])
            await pool.query(
                'INSERT INTO haw_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
                [id, `${id}@haw-hamburg.de`]
            )
    })
    afterAll(async () => {
        await pool.query('DELETE FROM haw_user WHERE id = ANY($1)', [
            [owner, other]
        ])
        await pool.end()
    })
    it('cascades user deletion and nulls reporter_id', async () => {
        const postId = crypto.randomUUID()
        await pool.query(
            `INSERT INTO haw_market_post(id,owner_id,type,category,title,description,status,expires_at)
             VALUES($1,$2,'offer','housing','Desk','A desk','active',now()+interval '30 days')`,
            [postId, owner]
        )
        await pool.query(
            'INSERT INTO haw_market_photo(id,post_id,owner_id,object_key,position) VALUES($1,$2,$3,$4,0)',
            [crypto.randomUUID(), postId, owner, `k-${crypto.randomUUID()}`]
        )
        await pool.query(
            'INSERT INTO haw_market_rules(user_id,version,accepted_at) VALUES($1,1,now())',
            [owner]
        )
        await pool.query(
            'INSERT INTO haw_market_message(id,post_id,sender_id,recipient_id,body,report_token) VALUES($1,$2,$3,$4,$5,$6)',
            [
                crypto.randomUUID(),
                postId,
                other,
                owner,
                'hi',
                crypto.randomUUID()
            ]
        )
        await pool.query(
            "INSERT INTO haw_market_report(id,kind,post_id,reporter_id,reason) VALUES($1,'post',$2,$3,'spam')",
            [crypto.randomUUID(), postId, other]
        )
        await expect(
            pool.query(
                "INSERT INTO haw_market_report(id,kind,post_id,reporter_id,reason) VALUES($1,'post',$2,$3,'spam')",
                [crypto.randomUUID(), postId, other]
            )
        ).rejects.toThrow()
        await expect(
            pool.query(
                `INSERT INTO haw_market_post(id,owner_id,type,category,title,description,status,expires_at)
                 VALUES($1,$2,'bogus','housing','x','x','active',now())`,
                [crypto.randomUUID(), owner]
            )
        ).rejects.toThrow()
        await pool.query('DELETE FROM haw_user WHERE id=$1', [owner])
        const count = async (table: string) =>
            Number(
                (await pool.query(`SELECT count(*) FROM ${table}`)).rows[0]
                    .count
            )
        expect(
            (
                await pool.query('SELECT 1 FROM haw_market_post WHERE id=$1', [
                    postId
                ])
            ).rowCount
        ).toBe(0)
        expect(await count('haw_market_photo')).toBe(0)
        expect(await count('haw_market_rules')).toBe(0)
        expect(await count('haw_market_message')).toBe(0)
        await pool.query('DELETE FROM haw_user WHERE id=$1', [other])
        const report = await pool.query(
            'SELECT reporter_id FROM haw_market_report'
        )
        expect(report.rows.every((r) => r.reporter_id === null)).toBe(true)
    })
    it('deletes legacy categories, enforces new checks and drops campus', async () => {
        const check = async (col: string) =>
            (
                await pool.query(
                    `SELECT conname FROM pg_constraint
                     WHERE conrelid = 'haw_market_post'::regclass AND contype = 'c'
                       AND pg_get_constraintdef(oid) LIKE $1`,
                    [`%${col}%`]
                )
            ).rows.map((r) => r.conname)
        expect(await check('category')).toEqual([
            'haw_market_post_category_check'
        ])
        expect(await check('status')).toEqual(['haw_market_post_status_check'])
        // Simulate pre-migration rows: lift the category check, insert legacy rows, re-run.
        await pool.query(
            'ALTER TABLE haw_market_post DROP CONSTRAINT haw_market_post_category_check'
        )
        const owner = `mkt-mig-${crypto.randomUUID()}`
        await pool.query(
            'INSERT INTO haw_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
            [owner, `${owner}@haw-hamburg.de`]
        )
        const legacy: Record<string, string> = {}
        for (const category of ['buySell', 'services', 'other', 'jobs']) {
            legacy[category] = crypto.randomUUID()
            await pool.query(
                `INSERT INTO haw_market_post(id,owner_id,type,category,title,description,status,expires_at)
                 VALUES($1,$2,'offer',$3,'Old','Old one','active',now()+interval '1 day')`,
                [legacy[category], owner, category]
            )
        }
        await pool.query(await sql())
        await pool.query(await sql())
        const left = (
            await pool.query(
                'SELECT id, category FROM haw_market_post WHERE id = ANY($1)',
                [Object.values(legacy)]
            )
        ).rows
        expect(left).toEqual([{ id: legacy.jobs, category: 'jobs' }])
        const insert = (category: string, status: string) =>
            pool.query(
                `INSERT INTO haw_market_post(id,owner_id,type,category,title,description,status,expires_at)
                 VALUES($1,$2,'offer',$3,'t','d',$4,now())`,
                [crypto.randomUUID(), owner, category, status]
            )
        await expect(insert('other', 'active')).rejects.toThrow()
        await expect(insert('buySell', 'active')).rejects.toThrow()
        await expect(insert('services', 'active')).rejects.toThrow()
        await insert('jobs', 'reserved')
        await insert('housing', 'closed')
        await expect(insert('housing', 'bogus')).rejects.toThrow()
        const cols = await pool.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name='haw_market_post'`
        )
        const names = cols.rows.map((c) => c.column_name)
        expect(names).not.toContain('campus')
        expect(names).toContain('details')
        await pool.query('DELETE FROM haw_user WHERE id=$1', [owner])
    })
})

describe('marketplace GraphQL schema', () => {
    const load = async () => {
        const dir = new URL('../../schema/', import.meta.url)
        const files = (await readdir(dir)).filter((f) => f.endsWith('.gql'))
        const parts = await Promise.all(
            files.map((f) => readFile(new URL(f, dir), 'utf8'))
        )
        return buildSchema(parts.join('\n'))
    }
    const registryKeys = [
        ...new Set(
            Object.values(MARKET_FIELDS).flatMap((byType) =>
                Object.values(byType).flatMap((specs) =>
                    specs.map((f) => f.key)
                )
            )
        )
    ].sort()

    it('MarketPost has details and no campus', async () => {
        const schema = await load()
        const post = schema.getType('MarketPost') as GraphQLObjectType
        const fields = post.getFields()
        expect(fields.campus).toBeUndefined()
        expect(String(fields.details.type)).toBe('MarketDetails!')
        const input = schema.getType('MarketPostInput')
        if (!isInputObjectType(input)) throw Error('MarketPostInput')
        expect(input.getFields().campus).toBeUndefined()
        expect(String(input.getFields().details.type)).toBe(
            'MarketDetailsInput!'
        )
        const filter = schema.getType('MarketFilter')
        if (!isInputObjectType(filter)) throw Error('MarketFilter')
        expect(filter.getFields().campus).toBeUndefined()
    })

    it('MarketDetails and MarketDetailsInput list every registry key once, optional', async () => {
        const schema = await load()
        const out = schema.getType('MarketDetails') as GraphQLObjectType
        const inp = schema.getType('MarketDetailsInput')
        if (!isInputObjectType(inp)) throw Error('MarketDetailsInput')
        const numbers = ['weeklyHours', 'deposit', 'sizeSqm', 'rooms']
        const multis = ['languages', 'rentIncludes', 'facilities']
        const expected = (key: string) =>
            numbers.includes(key)
                ? 'Int'
                : multis.includes(key)
                  ? '[String!]'
                  : 'String'
        expect(Object.keys(out.getFields()).sort()).toEqual(registryKeys)
        expect(Object.keys(inp.getFields()).sort()).toEqual(registryKeys)
        for (const key of registryKeys) {
            expect(String(out.getFields()[key].type)).toBe(expected(key))
            expect(String(inp.getFields()[key].type)).toBe(expected(key))
        }
    })
})
