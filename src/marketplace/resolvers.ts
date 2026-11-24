import { GraphQLError } from 'graphql'
import type { MarketPostWrite, Marketplace } from './service'
import { MARKET } from './validation'

type Context = { accountUserId?: string }
type Input = Omit<MarketPostWrite, 'photoIds'>

/** GraphQL sends null for absent optional fields; the validator treats only missing keys as absent. */
const withDetails = (input: Input): Input => ({
    ...input,
    details: Object.fromEntries(
        Object.entries(input.details ?? {}).filter(([, v]) => v != null)
    ) as Input['details']
})

const PASS_THROUGH = new Set([
    'SignInRequired',
    'RulesRequired',
    'Blocked',
    'ActivePostLimit',
    'PostUnavailable',
    'RenewWindowClosed',
    'InvalidMarketStatus',
    'MarketPostExpired',
    'AlreadyReported',
    'ContactLimit',
    'OwnPost',
    'MailUnavailable',
    'InvalidMarketMessage',
    'InvalidMarketReport'
])

const allowed = (message: string) =>
    PASS_THROUGH.has(message) ||
    /^InvalidMarketPost:(details\.)?[A-Za-z]+$/.test(message)

export function createMarketplaceResolvers(service: Marketplace | null) {
    async function guarded<T>(
        context: Context,
        run: (market: Marketplace, userId: string) => Promise<T>
    ): Promise<T> {
        if (!context.accountUserId)
            throw new GraphQLError('SignInRequired', {
                extensions: { code: 'UNAUTHENTICATED' }
            })
        if (!service) throw new GraphQLError('MarketplaceUnavailable')
        try {
            return await run(service, context.accountUserId)
        } catch (error) {
            throw new GraphQLError(
                error instanceof Error && allowed(error.message)
                    ? error.message
                    : 'MarketplaceUnavailable'
            )
        }
    }
    /** Browsing is public: a guest reads as viewer '' and never owns a post. */
    async function open<T>(
        context: Context,
        run: (market: Marketplace, viewer: string) => Promise<T>
    ): Promise<T> {
        if (!service) throw new GraphQLError('MarketplaceUnavailable')
        try {
            return await run(service, context.accountUserId ?? '')
        } catch (error) {
            throw new GraphQLError(
                error instanceof Error && allowed(error.message)
                    ? error.message
                    : 'MarketplaceUnavailable'
            )
        }
    }
    const done = async (work: Promise<unknown>) => {
        await work
        return true
    }

    return {
        Query: {
            marketPosts: (
                _: unknown,
                args: {
                    filter?: {
                        type?: string | null
                        category?: string | null
                    } | null
                    cursor?: string | null
                },
                context: Context
            ) =>
                open(context, (m, u) =>
                    m.list(u, { ...args.filter, cursor: args.cursor })
                ),
            marketPost: (_: unknown, args: { id: string }, context: Context) =>
                open(context, (m, u) => m.get(u, args.id)),
            myMarketPosts: (_: unknown, _args: unknown, context: Context) =>
                guarded(context, (m, u) => m.mine(u)),
            marketRulesAccepted: (
                _: unknown,
                _args: unknown,
                context: Context
            ) => guarded(context, (m, u) => m.rulesAccepted(u))
        },
        Mutation: {
            acceptMarketRules: (
                _: unknown,
                args: { version: number },
                context: Context
            ) =>
                guarded(context, (m, u) =>
                    done(m.acceptRules(u, args.version))
                ),
            createMarketPost: (
                _: unknown,
                args: { input: Input; photoIds?: string[] | null },
                context: Context
            ) =>
                guarded(context, (m, u) =>
                    m.create(u, {
                        ...withDetails(args.input),
                        photoIds: args.photoIds ?? null
                    })
                ),
            updateMarketPost: (
                _: unknown,
                args: { id: string; input: Input; photoIds?: string[] | null },
                context: Context
            ) =>
                guarded(context, (m, u) =>
                    m.update(u, args.id, {
                        ...withDetails(args.input),
                        photoIds: args.photoIds ?? null
                    })
                ),
            renewMarketPost: (
                _: unknown,
                args: { id: string },
                context: Context
            ) => guarded(context, (m, u) => m.renew(u, args.id)),
            setMarketPostStatus: (
                _: unknown,
                args: { id: string; status: string },
                context: Context
            ) =>
                guarded(context, (m, u) => {
                    if (
                        !(MARKET.ownerStatuses as readonly string[]).includes(
                            args.status
                        )
                    )
                        throw new GraphQLError('InvalidMarketStatus')
                    return m.setStatus(
                        u,
                        args.id,
                        args.status as (typeof MARKET.ownerStatuses)[number]
                    )
                }),
            deleteMarketPost: (
                _: unknown,
                args: { id: string },
                context: Context
            ) => guarded(context, (m, u) => done(m.remove(u, args.id))),
            reportMarketPost: (
                _: unknown,
                args: {
                    id: string
                    input: { reason: string; note?: string | null }
                },
                context: Context
            ) =>
                guarded(context, (m, u) =>
                    done(m.report(u, args.id, args.input))
                ),
            reportMarketMessage: (
                _: unknown,
                args: {
                    token: string
                    input: { reason: string; note?: string | null }
                },
                context: Context
            ) =>
                guarded(context, (m, u) =>
                    done(m.reportMessage(u, args.token, args.input))
                ),
            contactMarketPoster: (
                _: unknown,
                args: { id: string; message: string },
                context: Context
            ) =>
                guarded(context, (m, u) =>
                    done(m.contact(u, args.id, args.message))
                )
        }
    }
}
