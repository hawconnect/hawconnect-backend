import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { getMigrations } from 'better-auth/db/migration'
import { Pool } from 'pg'
import { createAccountAuth } from '@/lib/account-auth'
import { readLogoutTicket } from '@/lib/logout-ticket'
import {
    loadConfiguredOidcClients,
    oidcSecretVariable,
    syncOidcClients
} from '@/lib/oidc-clients'
import { CONSOLE_CLIENT_ID, createConsoleSignIn } from '../oidc-sign-in'

const API = 'http://localhost:4000'
const LOGIN = 'http://account.localhost:4000'
const WEB = 'http://localhost:8081'
const DASH = 'http://localhost:43127'
const SECRET = 'test-only-secret-with-at-least-thirty-two-characters'
const APP_SECRET = 'app-client-secret-with-at-least-thirty-two-chars'
const DASH_SECRET = 'dash-client-secret-with-at-least-thirty-two-chars'
const PASSWORD = 'correct horse 42 battery'

const base64url = (buffer: Buffer) => buffer.toString('base64url')

describe('createConsoleSignIn input checks (no database)', () => {
    const signIn = createConsoleSignIn({
        providerAuth: {} as never,
        loginOrigin: LOGIN,
        consoleOrigin: DASH,
        clientSecret: DASH_SECRET,
        accountSecret: SECRET
    })
    const valid = {
        code: 'abc',
        codeVerifier: 'v'.repeat(43),
        redirectUri: `${DASH}/auth/callback`,
        nonce: 'n'
    }

    it('accepts only the dashboard callback as redirect address', async () => {
        expect(
            await signIn.exchange({
                ...valid,
                redirectUri: `${API}/api/accounts/oidc/callback`
            })
        ).toEqual({ ok: false })
    })

    it('refuses a missing or malformed verifier, code or nonce', async () => {
        for (const patch of [
            { codeVerifier: undefined },
            { codeVerifier: 'short' },
            { code: '' },
            { code: 'x'.repeat(513) },
            { nonce: '' }
        ])
            expect(await signIn.exchange({ ...valid, ...patch })).toEqual({
                ok: false
            })
    })

    it('builds an authorize-free end-session address for the dashboard', () => {
        const url = new URL(signIn.endSessionUrl('user-1'))
        expect(`${url.origin}${url.pathname}`).toBe(
            `${LOGIN}/api/auth/oauth2/end-session`
        )
        expect(url.searchParams.get('client_id')).toBe(CONSOLE_CLIENT_ID)
        expect(url.searchParams.get('post_logout_redirect_uri')).toBe(
            `${DASH}/login`
        )
        expect(
            readLogoutTicket(SECRET, url.searchParams.get('ticket') ?? '')
        ).toBe('user-1')
    })
})

const databaseURL = process.env.HAWCONNECT_TEST_DATABASE_URL
const suite = databaseURL ? describe : describe.skip
suite(
    'dashboard sign-in through account.hawconnect.de (isolated PostgreSQL)',
    () => {
        const pool = new Pool({ connectionString: databaseURL })
        const env = {
            HAWCONNECT_AUTH_ORIGIN: API,
            HAWCONNECT_WEB_ORIGIN: WEB,
            HAWCONNECT_CONSOLE_ORIGIN: DASH,
            [oidcSecretVariable('hawconnect-app')]: APP_SECRET,
            [oidcSecretVariable(CONSOLE_CLIENT_ID)]: DASH_SECRET
        }
        const service = createAccountAuth({
            pool,
            secret: SECRET,
            baseURL: API,
            loginOrigin: LOGIN,
            webOrigin: WEB,
            registration: true,
            appClientSecret: APP_SECRET,
            send: async () => {}
        })
        const signIn = createConsoleSignIn({
            providerAuth: service.auth,
            loginOrigin: LOGIN,
            consoleOrigin: DASH,
            clientSecret: DASH_SECRET,
            accountSecret: SECRET
        })

        const confirmedUser = async () => {
            const email = `dash-${crypto.randomUUID()}@haw-hamburg.de`
            await service.auth.api.signUpEmail({
                body: { email, password: PASSWORD, name: '' }
            })
            await pool.query(
                'UPDATE haw_user SET "emailVerified" = true WHERE email = $1',
                [email]
            )
            return email
        }

        /** What the dashboard does: authorize, sign in at the login site, come back with a code. */
        const codeFor = async (email: string) => {
            const verifier = base64url(randomBytes(32))
            const nonce = base64url(randomBytes(16))
            const authorize = new URL(`${LOGIN}/api/auth/oauth2/authorize`)
            authorize.search = new URLSearchParams({
                response_type: 'code',
                client_id: CONSOLE_CLIENT_ID,
                redirect_uri: `${DASH}/auth/callback`,
                scope: 'openid email',
                state: base64url(randomBytes(16)),
                nonce,
                code_challenge: base64url(
                    createHash('sha256').update(verifier).digest()
                ),
                code_challenge_method: 'S256'
            }).toString()
            const first = await service.auth.handler(
                new Request(authorize.toString())
            )
            expect(first.status).toBe(302)
            const signInPage = new URL(
                first.headers.get('location') ?? '',
                LOGIN
            )
            const result = await service.actions.signIn(
                email,
                PASSWORD,
                new Headers({ origin: LOGIN }),
                signInPage.search.slice(1)
            )
            if (!result.ok) throw new Error(result.code)
            const back = new URL(result.value.redirect ?? '')
            expect(`${back.origin}${back.pathname}`).toBe(
                `${DASH}/auth/callback`
            )
            return {
                code: back.searchParams.get('code') ?? '',
                codeVerifier: verifier,
                redirectUri: `${DASH}/auth/callback`,
                nonce
            }
        }

        beforeAll(async () => {
            const migration = await getMigrations(service.auth.options)
            await migration.runMigrations()
            await syncOidcClients(
                service.auth,
                await loadConfiguredOidcClients(env),
                env
            )
        })
        afterAll(async () => {
            await pool.end()
        })

        it('redeems the code for the signed-in person', async () => {
            const email = await confirmedUser()
            const result = await signIn.exchange(await codeFor(email))
            expect(result.ok).toBe(true)
            if (!result.ok) return
            expect(result.user.email).toBe(email)
            expect(result.user.emailVerified).toBe(true)
        })

        it('refuses a wrong nonce and a replayed code', async () => {
            const email = await confirmedUser()
            const valid = await codeFor(email)
            expect(
                await signIn.exchange({ ...valid, nonce: 'someone-else' })
            ).toEqual({ ok: false })
            const other = await codeFor(email)
            expect((await signIn.exchange(other)).ok).toBe(true)
            expect(await signIn.exchange(other)).toEqual({ ok: false })
        })

        it('refuses a redemption with another client secret', async () => {
            const email = await confirmedUser()
            const valid = await codeFor(email)
            const stolen = createConsoleSignIn({
                providerAuth: service.auth,
                loginOrigin: LOGIN,
                consoleOrigin: DASH,
                clientSecret: APP_SECRET,
                accountSecret: SECRET
            })
            expect(await stolen.exchange(valid)).toEqual({ ok: false })
        })
    }
)
