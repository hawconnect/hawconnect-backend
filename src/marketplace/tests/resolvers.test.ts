import { describe, expect, it } from 'bun:test'
import { GraphQLError } from 'graphql'
import { createMarketplaceResolvers } from '../resolvers'
import type { Marketplace } from '../service'

const post = { id: 'p1' }
const input = { title: 'x' } as never
const report = { reason: 'scam' }

function fake(error?: Error) {
    const calls: unknown[][] = []
    const rec =
        (name: string, value: unknown) =>
        async (...args: unknown[]) => {
            calls.push([name, ...args])
            if (error) throw error
            return value
        }
    const service = {
        list: rec('list', { posts: [post], nextCursor: null }),
        get: rec('get', post),
        mine: rec('mine', [post]),
        rulesAccepted: rec('rulesAccepted', true),
        acceptRules: rec('acceptRules', undefined),
        create: rec('create', post),
        update: rec('update', post),
        renew: rec('renew', post),
        setStatus: rec('setStatus', post),
        remove: rec('remove', undefined),
        report: rec('report', undefined),
        reportMessage: rec('reportMessage', undefined),
        contact: rec('contact', undefined)
    } as unknown as Marketplace
    return { service, calls }
}

const ctx = { accountUserId: 'u1' }
const operations: [string, string, unknown[]][] = [
    ['Query', 'marketPosts', [{}]],
    ['Query', 'marketPost', [{ id: 'p1' }]],
    ['Query', 'myMarketPosts', [{}]],
    ['Query', 'marketRulesAccepted', [{}]],
    ['Mutation', 'acceptMarketRules', [{ version: 1 }]],
    ['Mutation', 'createMarketPost', [{ input }]],
    ['Mutation', 'updateMarketPost', [{ id: 'p1', input }]],
    ['Mutation', 'renewMarketPost', [{ id: 'p1' }]],
    ['Mutation', 'setMarketPostStatus', [{ id: 'p1', status: 'closed' }]],
    ['Mutation', 'deleteMarketPost', [{ id: 'p1' }]],
    ['Mutation', 'reportMarketPost', [{ id: 'p1', input: report }]],
    ['Mutation', 'reportMarketMessage', [{ token: 't', input: report }]],
    ['Mutation', 'contactMarketPoster', [{ id: 'p1', message: 'hello there' }]]
]

const run = (
    r: ReturnType<typeof createMarketplaceResolvers>,
    group: string,
    name: string,
    args: unknown,
    context: { accountUserId?: string }
) =>
    // biome-ignore lint/suspicious/noExplicitAny: dynamic lookup
    (r as any)[group][name](undefined, args, context)

const PUBLIC = ['marketPosts', 'marketPost']

describe('marketplace resolvers', () => {
    it('lets guests browse: list and single post run as viewer "" without an account', async () => {
        const { service, calls } = fake()
        const r = createMarketplaceResolvers(service)
        await run(r, 'Query', 'marketPosts', {}, {})
        await run(r, 'Query', 'marketPost', { id: 'p1' }, {})
        expect(calls.map((c) => [c[0], c[1]])).toEqual([
            ['list', ''],
            ['get', '']
        ])
    })
    for (const [group, name, [args]] of operations) {
        const needsAccount = PUBLIC.includes(name) ? it.skip : it
        needsAccount(
            `${name} requires sign-in before anything else`,
            async () => {
                for (const service of [fake().service, null]) {
                    const r = createMarketplaceResolvers(service)
                    const err = await run(r, group, name, args, {}).catch(
                        (e: unknown) => e
                    )
                    expect(err).toBeInstanceOf(GraphQLError)
                    expect((err as GraphQLError).message).toBe('SignInRequired')
                    expect((err as GraphQLError).extensions.code).toBe(
                        'UNAUTHENTICATED'
                    )
                }
            }
        )
        it(`${name} is MarketplaceUnavailable without a service`, async () => {
            const r = createMarketplaceResolvers(null)
            const err = await run(r, group, name, args, ctx).catch(
                (e: unknown) => e
            )
            expect((err as GraphQLError).message).toBe('MarketplaceUnavailable')
        })
        it(`${name} maps unexpected errors`, async () => {
            const r = createMarketplaceResolvers(
                fake(new Error('connection to db at 10.0.0.1 failed')).service
            )
            const err = await run(r, group, name, args, ctx).catch(
                (e: unknown) => e
            )
            expect((err as GraphQLError).message).toBe('MarketplaceUnavailable')
        })
    }

    for (const code of [
        'RulesRequired',
        'Blocked',
        'ActivePostLimit',
        'PostUnavailable',
        'RenewWindowClosed',
        'AlreadyReported',
        'ContactLimit',
        'OwnPost',
        'MailUnavailable',
        'InvalidMarketPost:title',
        'InvalidMarketPost:details.applyUrl',
        'InvalidMarketMessage',
        'InvalidMarketReport'
    ]) {
        it(`passes ${code} through`, async () => {
            const r = createMarketplaceResolvers(fake(new Error(code)).service)
            const err = await run(
                r,
                'Mutation',
                'createMarketPost',
                { input },
                ctx
            ).catch((e: unknown) => e)
            expect((err as GraphQLError).message).toBe(code)
        })
    }

    it('delegates with the signed-in user and returns results', async () => {
        const { service, calls } = fake()
        const r = createMarketplaceResolvers(service)
        expect(
            await run(
                r,
                'Query',
                'marketPosts',
                { filter: { type: 'offer' }, cursor: 'c' },
                ctx
            )
        ).toEqual({ posts: [post], nextCursor: null })
        expect(calls[0]).toEqual(['list', 'u1', { type: 'offer', cursor: 'c' }])
        expect(await run(r, 'Query', 'marketPost', { id: 'p1' }, ctx)).toEqual(
            post
        )
        expect(
            await run(r, 'Mutation', 'deleteMarketPost', { id: 'p1' }, ctx)
        ).toBe(true)
        expect(
            await run(r, 'Mutation', 'acceptMarketRules', { version: 1 }, ctx)
        ).toBe(true)
        await run(
            r,
            'Mutation',
            'updateMarketPost',
            { id: 'p1', input: { a: 1 }, photoIds: ['x'] },
            ctx
        )
        expect(calls.at(-1)).toEqual([
            'update',
            'u1',
            'p1',
            { a: 1, details: {}, photoIds: ['x'] }
        ])
        await run(r, 'Mutation', 'createMarketPost', { input: { a: 1 } }, ctx)
        expect(calls.at(-1)).toEqual([
            'create',
            'u1',
            { a: 1, details: {}, photoIds: null }
        ])
    })
})

describe('marketplace details resolver', () => {
    it('drops null detail keys before calling the service', async () => {
        const { service, calls } = fake()
        const r = createMarketplaceResolvers(service)
        const details = { employer: 'Acme', skills: null, rooms: null }
        await run(
            r,
            'Mutation',
            'createMarketPost',
            { input: { title: 'x', details } },
            ctx
        )
        await run(
            r,
            'Mutation',
            'updateMarketPost',
            { id: 'p1', input: { title: 'x', details } },
            ctx
        )
        for (const call of calls) {
            const written = call[call.length - 1] as {
                details: Record<string, unknown>
            }
            expect(written.details).toEqual({ employer: 'Acme' })
        }
        expect(calls).toHaveLength(2)
    })
})
