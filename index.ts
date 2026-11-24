import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ApolloServer } from '@apollo/server'
import {
    ApolloServerPluginLandingPageLocalDefault,
    ApolloServerPluginLandingPageProductionDefault
} from '@apollo/server/plugin/landingPage/default'
import { expressMiddleware } from '@as-integrations/express5'
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node'
import cors from 'cors'
import express from 'express'
import NodeCache from 'node-cache'
import { getAccountOwner } from '@/lib/account-auth'
import { accountRuntime } from '@/lib/account-runtime'
import {
    loadConfiguredOidcClients,
    oidcClientsProblem,
    syncConfiguredOidcClients
} from '@/lib/oidc-clients'
import {
    createLoginHost,
    loginHostGate,
    unavailableLoginHost
} from '@/login/router'
import { createLocalPhotoRouter } from '@/marketplace/local-photo-storage'
import { createMarketplacePhotoRouter } from '@/marketplace/photo-router'
import { marketplaceRuntime } from '@/marketplace/runtime'
import { createAdminRouter } from './src/admin/router'
import { createAdminRuntime } from './src/admin/runtime'
import {
    aliasLimit,
    createRateLimiter,
    depthLimit,
    jsonLimitFor,
    MAX_ALIASES,
    MAX_QUERY_DEPTH
} from './src/lib/graphql-limits'
import { myHawCalendarRouter } from './src/lib/myhaw-calendar-router'
import { createPublicQuickLinksRouter } from './src/lib/quick-links-router'
import { securityHeaders } from './src/lib/security-headers'
import { configureTrustProxy } from './src/lib/trust-proxy'
import { startMarketplaceCleanup } from './src/marketplace/cleanup'
import { resolvers } from './src/resolvers'
import { startAcademicCalendarRefresh } from './src/utils/academic-calendar'
import { startCafeteriaRefresh } from './src/utils/cafeteria-refresh'
import { startFoodRefresh } from './src/utils/food-refresh'
import { startHawEventsRefresh } from './src/utils/haw-events'
import { startHawNewsRefresh } from './src/utils/haw-news'

const schemaFiles = [
    'enums.gql',
    'scalars.gql',
    'types.gql',
    'inputs.gql',
    'schema.gql'
]
const schemaDir = path.join(__dirname, 'src', 'schema')

const typeDefs = schemaFiles.map((file) => {
    const filePath = path.join(schemaDir, file)
    try {
        return readFileSync(filePath, { encoding: 'utf-8' })
    } catch (error) {
        console.error(`Error reading file ${filePath}:`, error)
        throw error
    }
})
const port = process.env.PORT || 4000

const app = express()
app.disable('x-powered-by')
configureTrustProxy(app, process.env.HAWCONNECT_TRUSTED_PROXY_HOPS)
app.use(securityHeaders())

// account.hawconnect.de: requests for the login host get only the login pages and the
// allow-listed provider routes (src/login/router.ts); no other route answers there,
// and none of these answer on the API host.
const loginOrigin = process.env.HAWCONNECT_LOGIN_ORIGIN
if (loginOrigin) {
    const clients = accountRuntime
        ? await loadConfiguredOidcClients().catch((error) => {
              // Names the variable or file at fault, never a value.
              console.error(
                  `OIDC clients not loaded: ${oidcClientsProblem(error)}`
              )
              return []
          })
        : []
    app.use(
        loginHostGate(
            loginOrigin,
            accountRuntime
                ? createLoginHost({
                      auth: accountRuntime.auth,
                      actions: accountRuntime.actions,
                      limited: accountRuntime.limited,
                      clients,
                      loginOrigin
                  })
                : unavailableLoginHost(loginOrigin)
        )
    )
}
app.use(
    cors({
        credentials: true,
        origin: (
            process.env.HAWCONNECT_WEB_ORIGINS ??
            'http://localhost:3000,http://localhost:3001,http://localhost:8081'
        )
            .split(',')
            .map((origin) => origin.trim())
            .filter(Boolean)
    })
)

app.use('/api/admin', createAdminRouter(createAdminRuntime()))

app.use('/api/calendar/myhaw', myHawCalendarRouter)
app.use(
    '/api/quick-links',
    createPublicQuickLinksRouter(accountRuntime?.pool ?? null)
)
if (accountRuntime)
    // A bad configuration or a database not yet migrated must never stop the server.
    void syncConfiguredOidcClients(accountRuntime.auth).catch((error) =>
        console.error(`OIDC clients not synced: ${oidcClientsProblem(error)}`)
    )

// Only our bounded, domain-restricted wrapper is public. Never expose raw /api/auth routes
// on the API host; the login host forwards only the provider allow-list (src/login/router.ts).
app.all('/api/accounts/*path', (req, res, next) => {
    req.headers['x-hawconnect-client-ip'] = req.ip ?? 'unknown'
    if (!accountRuntime) {
        res.status(503)
            .set('Cache-Control', 'no-store')
            .json({ error: 'AccountUnavailable' })
        return
    }
    void toNodeHandler(accountRuntime.handler)(req, res).catch(next)
})

if (marketplaceRuntime?.localPhotos)
    app.use(
        '/api/marketplace/dev-photos',
        createLocalPhotoRouter(marketplaceRuntime.localPhotos)
    )
const photoAccounts = accountRuntime
app.use(
    '/api/marketplace/photos',
    marketplaceRuntime && photoAccounts
        ? createMarketplacePhotoRouter({
              owner: (req) =>
                  getAccountOwner(photoAccounts, fromNodeHeaders(req.headers)),
              storage: marketplaceRuntime.storage,
              pool: marketplaceRuntime.pool,
              blocked: marketplaceRuntime.service.isBlocked,
              rulesAccepted: marketplaceRuntime.service.rulesAccepted
          })
        : (_req, res) => {
              res.status(503)
                  .set('Cache-Control', 'no-store')
                  .json({ error: 'PhotoUnavailable' })
          }
)

const apolloServer = new ApolloServer({
    typeDefs,
    resolvers,
    plugins: [
        Bun.env.NODE_ENV === 'production'
            ? ApolloServerPluginLandingPageProductionDefault({
                  footer: false
              })
            : ApolloServerPluginLandingPageLocalDefault()
    ],
    // The schema is public in the repository; the live API does not hand it out.
    introspection: process.env.NODE_ENV !== 'production',
    // Also drops "Did you mean …?" field hints from validation errors.
    hideSchemaDetailsFromClientErrors: process.env.NODE_ENV === 'production',
    validationRules: [depthLimit(MAX_QUERY_DEPTH), aliasLimit(MAX_ALIASES)],
    formatError(formattedError, error) {
        // Do not print variables, tokens or personal calendar payloads.
        if (error instanceof Error && process.env.NODE_ENV !== 'test')
            console.error('GraphQL request failed')
        // Never send stack traces, whatever NODE_ENV is.
        const { stacktrace: _stacktrace, ...extensions } =
            formattedError.extensions ?? {}
        return { ...formattedError, extensions }
    }
})

export const cache = new NodeCache({
    stdTTL: 60 * 10,
    maxKeys: 1000,
    checkperiod: 60,
    useClones: false,
    deleteOnExpire: true
})
await apolloServer.start()

// Generous: students on campus Wi-Fi share one public address.
const graphqlRateLimit = createRateLimiter({ max: 1500, windowMs: 60_000 })
app.use(
    '/graphql',
    (req, res, next) => {
        if (graphqlRateLimit(req.ip ?? 'unknown')) return next()
        res.status(429)
            .set('Cache-Control', 'no-store')
            .json({ errors: [{ message: 'TooManyRequests' }] })
    },
    (req, res, next) =>
        express.json({ limit: jsonLimitFor(req.headers) })(req, res, next),
    expressMiddleware(apolloServer, {
        context: async ({ req }): Promise<{ accountUserId?: string }> => {
            if (
                !accountRuntime ||
                (!req.headers.cookie && !req.headers.authorization)
            )
                return {}
            const owner = await getAccountOwner(
                accountRuntime,
                fromNodeHeaders(req.headers)
            )
            return owner ? { accountUserId: owner } : {}
        }
    })
)

// The API docs page moved from /hawconnect-api to /backend-api; keep old links working.
app.get('/hawconnect-api', (_req, res) => res.redirect(301, '/backend-api'))

app.use(
    '/',
    express.static(path.join(__dirname, 'docs', 'out'), {
        extensions: ['html']
    })
)

startFoodRefresh()
startCafeteriaRefresh()
startAcademicCalendarRefresh()
startHawEventsRefresh()
startHawNewsRefresh()
startMarketplaceCleanup()

app.listen(port, () => {
    console.log(`🚀 Server ready at http://localhost:${port}/graphql`)
})
