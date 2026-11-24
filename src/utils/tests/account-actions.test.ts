import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { getMigrations } from 'better-auth/db/migration'
import { Pool } from 'pg'
import { createAccountActions } from '../../lib/account-actions'
import { type AccountMail, createAccountAuth } from '../../lib/account-auth'

const databaseURL = process.env.HAWCONNECT_TEST_DATABASE_URL
const suite = databaseURL ? describe : describe.skip
suite('shared account actions (isolated PostgreSQL)', () => {
    const pool = new Pool({ connectionString: databaseURL })
    const sent: AccountMail[] = []
    let failMail = false
    const service = createAccountAuth({
        pool,
        secret: 'test-only-secret-with-at-least-thirty-two-characters',
        baseURL: 'http://localhost:4000',
        loginOrigin: 'http://account.localhost:4000',
        webOrigin: 'http://localhost:3001',
        registration: true,
        send: async (message) => {
            if (failMail) throw new Error('smtp down')
            sent.push(message)
        }
    })
    const { actions } = service
    const address = (name: string) =>
        `${name}-${crypto.randomUUID()}@mail.example.org`
    const password = 'correct horse 42'
    const tokenOf = (mail?: AccountMail) =>
        new URL(mail?.url ?? '').searchParams.get('token') as string
    const headers = () =>
        new Headers({
            'user-agent': 'action-test',
            'x-forwarded-for': '203.0.113.9'
        })
    const verified = async (email: string) => {
        expect((await actions.register(email, password)).ok).toBe(true)
        const mail = sent.at(-1)
        expect((await actions.verifyEmail(tokenOf(mail))).ok).toBe(true)
        return mail
    }
    beforeAll(async () => {
        const migration = await getMigrations(service.auth.options)
        await migration.runMigrations()
    })
    afterAll(async () => {
        await pool.end()
    })

    it('exposes the shared rate limiter for the login pages', async () => {
        expect(typeof service.limited).toBe('function')
        expect(await service.limited(`test:${crypto.randomUUID()}`, 1)).toBe(
            false
        )
    })

    it('registers and mails a login-site confirm link with the token in the query', async () => {
        const email = address('reg')
        const result = await actions.register(email, password)
        expect(result).toEqual({ ok: true, value: { status: 'sent' } })
        const link = new URL(sent.at(-1)?.url ?? '')
        expect(sent.at(-1)?.kind).toBe('verify')
        expect(link.origin).toBe('http://account.localhost:4000')
        expect(link.pathname).toBe('/confirm')
        expect(link.hash).toBe('')
        expect(tokenOf(sent.at(-1)).length).toBeGreaterThan(16)
    })

    it('register reports invalid input, rate limits and mail failures by code', async () => {
        expect(await actions.register('a@localhost', password)).toEqual({
            ok: false,
            code: 'InvalidAccountEmail'
        })
        expect(await actions.register(address('p'), 'short')).toEqual({
            ok: false,
            code: 'InvalidPassword'
        })
        failMail = true
        expect(await actions.register(address('m'), password)).toEqual({
            ok: false,
            code: 'MailUnavailable'
        })
        failMail = false
        const email = address('limit')
        for (let i = 0; i < 3; i++)
            expect((await actions.register(email, password)).ok).toBe(true)
        expect(await actions.register(email, password)).toEqual({
            ok: false,
            code: 'TooManyRequests'
        })
    })

    it('register answers the same for a confirmed address and mails the exists notice', async () => {
        const email = address('exists')
        await verified(email)
        const result = await actions.register(email, password)
        expect(result).toEqual({ ok: true, value: { status: 'sent' } })
        expect(sent.at(-1)?.kind).toBe('exists')
        expect(sent.at(-1)?.url).toBe('http://account.localhost:4000/sign-in')
    })

    it('signIn maps a refusal other than an unconfirmed email to InvalidCredentials', async () => {
        // better-auth skips its origin check under NODE_ENV=test, so its 403
        // answers are replayed here through a stand-in handler.
        const refusing = (code: string) =>
            createAccountActions({
                auth: {
                    ...service.auth,
                    handler: async () =>
                        Response.json({ code, message: code }, { status: 403 })
                },
                pool,
                baseURL: 'http://account.localhost:4000',
                loginOrigin: 'http://account.localhost:4000',
                registration: true,
                limited: async () => false
            })
        const email = address('refused')
        for (const code of [
            'MISSING_OR_NULL_ORIGIN',
            'INVALID_ORIGIN',
            'CROSS_SITE_NAVIGATION_LOGIN_BLOCKED'
        ])
            expect(
                await refusing(code).signIn(email, password, headers())
            ).toEqual({ ok: false, code: 'InvalidCredentials' })
        expect(
            await refusing('EMAIL_NOT_VERIFIED').signIn(
                email,
                password,
                headers()
            )
        ).toEqual({ ok: false, code: 'EmailNotVerified' })
    })

    it('verifyEmail confirms once, never signs in, and rejects bad tokens', async () => {
        const email = address('verify')
        await actions.register(email, password)
        const token = tokenOf(sent.at(-1))
        expect(await actions.verifyEmail(token)).toEqual({
            ok: true,
            value: { status: 'verified' }
        })
        expect(await actions.verifyEmail('short')).toEqual({
            ok: false,
            code: 'InvalidLink'
        })
        expect(await actions.verifyEmail('x'.repeat(40))).toEqual({
            ok: false,
            code: 'InvalidLink'
        })
    })

    it('signIn maps unverified, wrong, malformed and throttled attempts to codes', async () => {
        const email = address('signin')
        await actions.register(email, password)
        expect(await actions.signIn(email, password, headers())).toEqual({
            ok: false,
            code: 'EmailNotVerified'
        })
        await actions.verifyEmail(tokenOf(sent.at(-1)))
        expect(
            await actions.signIn(email, 'wrong password 1', headers())
        ).toEqual({ ok: false, code: 'InvalidCredentials' })
        expect(
            await actions.signIn('a@localhost', password, headers())
        ).toEqual({ ok: false, code: 'InvalidCredentials' })
        expect(await actions.signIn(email, 'short', headers())).toEqual({
            ok: false,
            code: 'InvalidCredentials'
        })
        // Counted so far: unverified, wrong password (malformed input is not counted).
        for (let i = 0; i < 3; i++)
            expect(
                (await actions.signIn(email, 'wrong password 2', headers())).ok
            ).toBe(false)
        const sixth = await actions.signIn(email, password, headers())
        expect(sixth).toEqual({ ok: false, code: 'TooManyRequests' })
    })

    it('signIn returns the user, a bearer token and the session cookie', async () => {
        const email = address('good')
        await verified(email)
        const result = await actions.signIn(email, password, headers())
        if (!result.ok) throw new Error(result.code)
        expect(result.value.user.email).toBe(email)
        expect(result.value.token.length).toBeGreaterThan(10)
        expect(result.value.setCookie.length).toBeGreaterThan(0)
        expect(result.value.setCookie[0]).toContain('hawconnect.session_token=')
        const row = await pool.query(
            'SELECT "userAgent" FROM haw_session WHERE token = $1',
            [result.value.token]
        )
        expect(row.rows[0]?.userAgent).toBe('action-test')
    })

    it('resendVerification and forgotPassword validate, limit and mail', async () => {
        const email = address('resend')
        await actions.register(email, password)
        sent.length = 0
        expect(await actions.resendVerification('nope')).toEqual({
            ok: false,
            code: 'InvalidAccountEmail'
        })
        expect(await actions.forgotPassword('nope')).toEqual({
            ok: false,
            code: 'InvalidAccountEmail'
        })
        expect(await actions.resendVerification(email)).toEqual({
            ok: true,
            value: { status: 'sent' }
        })
        expect(sent.at(-1)?.kind).toBe('verify')
        await actions.verifyEmail(tokenOf(sent.at(-1)))
        expect(await actions.forgotPassword(email)).toEqual({
            ok: true,
            value: { status: 'sent' }
        })
        const reset = new URL(sent.at(-1)?.url ?? '')
        expect(sent.at(-1)?.kind).toBe('reset')
        expect(reset.origin).toBe('http://account.localhost:4000')
        expect(reset.pathname).toBe('/reset-password')
        expect(reset.hash).toBe('')
        expect((await actions.resendVerification(email)).ok).toBe(true)
        expect((await actions.resendVerification(email)).ok).toBe(true)
        expect(await actions.resendVerification(email)).toEqual({
            ok: false,
            code: 'TooManyRequests'
        })
        const other = address('fail')
        failMail = true
        expect(await actions.forgotPassword(other)).toEqual({
            ok: true,
            value: { status: 'sent' }
        })
        failMail = false
    })

    it('resetPassword validates the link and password, and a link works once', async () => {
        const email = address('reset')
        await verified(email)
        await actions.forgotPassword(email)
        const token = tokenOf(sent.at(-1))
        expect(
            await actions.resetPassword('short', 'a new password 1')
        ).toEqual({ ok: false, code: 'InvalidLink' })
        expect(await actions.resetPassword(token, 'short')).toEqual({
            ok: false,
            code: 'InvalidPassword'
        })
        expect(await actions.resetPassword(token, 'a new password 1')).toEqual({
            ok: true,
            value: { status: 'reset' }
        })
        expect(await actions.resetPassword(token, 'a new password 2')).toEqual({
            ok: false,
            code: 'InvalidLink'
        })
        expect((await actions.signIn(email, password, headers())).ok).toBe(
            false
        )
        expect(
            (await actions.signIn(email, 'a new password 1', headers())).ok
        ).toBe(true)
    })
})
