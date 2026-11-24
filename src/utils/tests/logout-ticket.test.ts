import { describe, expect, it } from 'bun:test'
import { createHmac } from 'node:crypto'
import { createLogoutTicket, readLogoutTicket } from '../../lib/logout-ticket'

const SECRET = 'test-only-secret-with-at-least-thirty-two-characters'
const NOW = Date.UTC(2026, 10, 15, 12)

describe('logout ticket', () => {
    it('names the user for 60 seconds', () => {
        const ticket = createLogoutTicket(SECRET, 'user-1', NOW)
        expect(readLogoutTicket(SECRET, ticket, NOW)).toBe('user-1')
        expect(readLogoutTicket(SECRET, ticket, NOW + 59_000)).toBe('user-1')
        expect(readLogoutTicket(SECRET, ticket, NOW + 61_000)).toBeNull()
    })

    it('is base64url({u, exp}) and an HMAC over the prefixed payload', () => {
        const ticket = createLogoutTicket(SECRET, 'user-1', NOW)
        const [payload, signature] = ticket.split('.')
        expect(
            JSON.parse(Buffer.from(payload, 'base64url').toString())
        ).toEqual({
            u: 'user-1',
            exp: Math.floor(NOW / 1000) + 60
        })
        expect(signature).toBe(
            createHmac('sha256', SECRET)
                .update(`hawconnect.logout:${payload}`)
                .digest('base64url')
        )
    })

    it('refuses forged, re-signed or malformed tickets', () => {
        const ticket = createLogoutTicket(SECRET, 'user-1', NOW)
        const [, signature] = ticket.split('.')
        const other = Buffer.from(
            JSON.stringify({ u: 'user-2', exp: Math.floor(NOW / 1000) + 60 })
        ).toString('base64url')
        for (const value of [
            `${other}.${signature}`,
            createLogoutTicket(
                'another-secret-with-at-least-32-chars!!',
                'user-1',
                NOW
            ),
            `${ticket}.x`,
            ticket.split('.')[0],
            '',
            'a.b',
            `${Buffer.from('not json').toString('base64url')}.${signature}`
        ])
            expect(readLogoutTicket(SECRET, value, NOW)).toBeNull()
    })
})
