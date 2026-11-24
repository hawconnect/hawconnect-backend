import { describe, expect, it } from 'bun:test'
import { normaliseAccountEmail } from '../account-policy'

describe('HAWConnect account email policy', () => {
    it('normalises a mailbox from any domain', () => {
        expect(normaliseAccountEmail('  Example.Name@HAW-HAMBURG.DE  ')).toBe(
            'example.name@haw-hamburg.de'
        )
        expect(normaliseAccountEmail('Guest@Mail.Example.org')).toBe(
            'guest@mail.example.org'
        )
    })
    it('rejects malformed input and header injection', () => {
        for (const value of [
            '',
            '@haw-hamburg.de',
            'a@@haw-hamburg.de',
            'a b@haw-hamburg.de',
            'a\r\nBcc:x@test.com@haw-hamburg.de',
            '.a@haw-hamburg.de',
            'a..b@haw-hamburg.de',
            'a@localhost',
            'a@-bad.example',
            'a@exa mple.org',
            'a@example.org\r\nBcc: x@test.com',
            'a@hаw-hamburg.de',
            'a@example..org',
            'a@[127.0.0.1]'
        ]) {
            expect(() => normaliseAccountEmail(value)).toThrow(
                'InvalidAccountEmail'
            )
        }
    })
})
