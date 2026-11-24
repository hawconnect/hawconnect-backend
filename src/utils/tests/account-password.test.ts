import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { getMigrations } from 'better-auth/db/migration'
import { Pool } from 'pg'
import { type AccountMail, createAccountAuth } from '../../lib/account-auth'

const databaseURL = process.env.HAWCONNECT_TEST_DATABASE_URL
const suite = databaseURL ? describe : describe.skip
suite('email and password accounts (isolated PostgreSQL)', () => {
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
    const request = (
        path: string,
        body?: unknown,
        options: { cookie?: string; native?: boolean } = {}
    ) =>
        service.handler(
            new Request(`http://localhost:4000/api/accounts/${path}`, {
                method: body ? 'POST' : 'GET',
                headers: {
                    Origin: options.native
                        ? 'hawconnect://'
                        : 'http://localhost:3001',
                    'x-hawconnect-client-ip': crypto.randomUUID(),
                    ...(options.native
                        ? { 'x-hawconnect-client': 'native' }
                        : {}),
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                    ...(options.cookie ? { cookie: options.cookie } : {})
                },
                ...(body ? { body: JSON.stringify(body) } : {})
            })
        )
    const cookiesOf = (response: Response) =>
        response.headers
            .getSetCookie()
            .map((s) => s.split(';')[0])
            .join('; ')
    const tokenOf = (mail: AccountMail | undefined) =>
        new URL(mail?.url ?? '').searchParams.get('token') as string
    const address = (name: string) =>
        `${name}-${crypto.randomUUID()}@mail.example.org`
    const password = 'correct horse 42'
    const register = async (email: string) => {
        expect((await request('register', { email, password })).status).toBe(
            200
        )
        return sent.at(-1)
    }
    beforeAll(async () => {
        const migration = await getMigrations(service.auth.options)
        await migration.runMigrations()
    })
    afterAll(async () => {
        await pool.end()
    })

    it('registers, requires email confirmation, then signs in with the password', async () => {
        const email = address('flow')
        const mail = await register(email)
        expect(mail?.kind).toBe('verify')
        expect(mail?.email).toBe(email)
        const link = new URL(mail?.url ?? '')
        expect(link.origin).toBe('http://account.localhost:4000')
        expect(link.pathname).toBe('/confirm')
        expect(link.hash).toBe('')
        expect([...link.searchParams.keys()]).toEqual(['token'])

        const early = await request('sign-in', { email, password })
        expect(early.status).toBe(403)
        expect(await early.json()).toEqual({ error: 'EmailNotVerified' })

        const confirmed = await request('confirm', {
            token: tokenOf(mail),
            kind: 'verify'
        })
        expect(confirmed.status).toBe(200)
        expect(await confirmed.json()).toEqual({ status: 'verified' })
        // Confirming proves the mailbox only; it never signs in.
        expect(confirmed.headers.getSetCookie()).toHaveLength(0)

        const signedIn = await request('sign-in', { email, password })
        expect(signedIn.status).toBe(200)
        expect(
            (
                await request('session', undefined, {
                    cookie: cookiesOf(signedIn)
                })
            ).status
        ).toBe(200)
    })

    it('lets the latest registration set the password of an unconfirmed account', async () => {
        const email = address('prehijack')
        await register(email)
        expect(
            (
                await request('register', {
                    email,
                    password: 'the real owner 99'
                })
            ).status
        ).toBe(200)
        const mail = sent.at(-1)
        expect(mail?.kind).toBe('verify')
        await request('confirm', { token: tokenOf(mail), kind: 'verify' })
        expect((await request('sign-in', { email, password })).status).toBe(401)
        expect(
            (await request('sign-in', { email, password: 'the real owner 99' }))
                .status
        ).toBe(200)
    })

    it('rejects a tampered confirmation link', async () => {
        const email = address('tamper')
        const token = tokenOf(await register(email))
        const bad = await request('confirm', {
            token: `${token.slice(0, -4)}AAAA`,
            kind: 'verify'
        })
        expect(bad.status).toBe(400)
        expect((await request('sign-in', { email, password })).status).toBe(403)
    })

    it('gives one generic answer for a wrong password and an unknown email', async () => {
        const email = address('wrong')
        const token = tokenOf(await register(email))
        await request('confirm', { token, kind: 'verify' })
        for (const body of [
            { email, password: 'not the password' },
            { email: address('nobody'), password },
            { email, password: 'short' },
            { email: 'not-an-email', password }
        ]) {
            const response = await request('sign-in', body)
            expect(response.status).toBe(401)
            expect(await response.json()).toEqual({
                error: 'InvalidCredentials'
            })
        }
    })

    it('rejects weak passwords and malformed emails at registration', async () => {
        const before = sent.length
        expect(
            (
                await request('register', {
                    email: address('weak'),
                    password: '1234567'
                })
            ).status
        ).toBe(400)
        expect(
            (await request('register', { email: 'a@localhost', password }))
                .status
        ).toBe(400)
        expect(sent.length).toBe(before)
    })

    it('answers the same for an existing account and tells its owner by email instead', async () => {
        const email = address('exists')
        const token = tokenOf(await register(email))
        await request('confirm', { token, kind: 'verify' })
        const again = await request('register', {
            email,
            password: 'another password 1'
        })
        expect(again.status).toBe(200)
        expect(await again.json()).toEqual({ status: 'sent' })
        expect(sent.at(-1)?.kind).toBe('exists')
        expect(sent.at(-1)?.email).toBe(email)
        // The second registration must not have replaced the password.
        expect(
            (
                await request('sign-in', {
                    email,
                    password: 'another password 1'
                })
            ).status
        ).toBe(401)
        expect((await request('sign-in', { email, password })).status).toBe(200)
    })

    it('resends the confirmation to an unconfirmed account, silently ignores others', async () => {
        const email = address('resend')
        await register(email)
        const before = sent.length
        expect((await request('resend-verification', { email })).status).toBe(
            200
        )
        expect(sent.length).toBe(before + 1)
        expect(sent.at(-1)?.kind).toBe('verify')
        expect(
            (await request('resend-verification', { email: address('none') }))
                .status
        ).toBe(200)
        expect(sent.length).toBe(before + 1)
    })

    it('resets the password once, signs out other sessions, and hides unknown emails', async () => {
        const email = address('reset')
        const token = tokenOf(await register(email))
        await request('confirm', { token, kind: 'verify' })
        const session = cookiesOf(await request('sign-in', { email, password }))
        const before = sent.length
        expect(
            (await request('forgot-password', { email: address('ghost') }))
                .status
        ).toBe(200)
        expect(sent.length).toBe(before)
        expect((await request('forgot-password', { email })).status).toBe(200)
        const mail = sent.at(-1)
        expect(mail?.kind).toBe('reset')
        const resetLink = new URL(mail?.url ?? '')
        expect(resetLink.origin).toBe('http://account.localhost:4000')
        expect(resetLink.pathname).toBe('/reset-password')
        expect(resetLink.hash).toBe('')
        const reset = tokenOf(mail)
        expect(
            (
                await request('reset-password', {
                    token: reset,
                    password: 'short'
                })
            ).status
        ).toBe(400)
        const fresh = 'a brand new password'
        expect(
            (await request('reset-password', { token: reset, password: fresh }))
                .status
        ).toBe(200)
        expect(
            (await request('reset-password', { token: reset, password: fresh }))
                .status
        ).toBe(400)
        expect(
            (await request('session', undefined, { cookie: session })).status
        ).toBe(401)
        expect((await request('sign-in', { email, password })).status).toBe(401)
        expect(
            (await request('sign-in', { email, password: fresh })).status
        ).toBe(200)
    })

    it('lets an account created without a password set one through forgot password', async () => {
        const id = `legacy-${crypto.randomUUID()}`
        const email = address('legacy')
        await pool.query(
            'INSERT INTO haw_user(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())',
            [id, email]
        )
        expect((await request('forgot-password', { email })).status).toBe(200)
        const fresh = 'my first password'
        expect(
            (
                await request('reset-password', {
                    token: tokenOf(sent.at(-1)),
                    password: fresh
                })
            ).status
        ).toBe(200)
        expect(
            (await request('sign-in', { email, password: fresh })).status
        ).toBe(200)
    })

    it('limits password attempts and emails per address', async () => {
        const email = address('limit')
        const token = tokenOf(await register(email))
        await request('confirm', { token, kind: 'verify' })
        const statuses: number[] = []
        for (let i = 0; i < 6; i++)
            statuses.push(
                (
                    await request('sign-in', {
                        email,
                        password: 'wrong password'
                    })
                ).status
            )
        expect(statuses).toEqual([401, 401, 401, 401, 401, 429])
        const mails: number[] = []
        for (let i = 0; i < 4; i++)
            mails.push((await request('forgot-password', { email })).status)
        expect(mails).toEqual([200, 200, 200, 429])
    })

    it('fails honestly when mail delivery is unavailable', async () => {
        failMail = true
        try {
            const response = await request('register', {
                email: address('nomail'),
                password
            })
            expect(response.status).toBe(503)
            expect(await response.json()).toEqual({ error: 'MailUnavailable' })
        } finally {
            failMail = false
        }
    })

    it('returns a bearer token only to the native app', async () => {
        const email = address('native')
        const token = tokenOf(await register(email))
        await request('confirm', { token, kind: 'verify' }, { native: true })
        const web = await request('sign-in', { email, password })
        expect((await web.json()).token).toBeUndefined()
        const signedIn = await request(
            'sign-in',
            { email, password },
            { native: true }
        )
        expect(typeof (await signedIn.json()).token).toBe('string')
    })

    it('has no emailed sign-in link for public accounts', async () => {
        expect(
            (await request('request-link', { email: address('link') })).status
        ).toBe(404)
        expect(
            (await request('confirm', { token: 'x'.repeat(32) })).status
        ).toBe(400)
    })
})
