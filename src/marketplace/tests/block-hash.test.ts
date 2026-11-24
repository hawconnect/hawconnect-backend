import { expect, test } from 'bun:test'
import { blockHash } from '../block-hash'

const s = 'test-block-secret'

test('normalises email before hashing', () => {
    expect(blockHash(' A@HAW-Hamburg.de ', s)).toBe(
        blockHash('a@haw-hamburg.de', s)
    )
})

test('is a keyed HMAC-SHA256 hex digest', () => {
    const h = blockHash('a@haw-hamburg.de', s)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).not.toBe(blockHash('a@haw-hamburg.de', 'other-secret'))
    expect(h).not.toBe(blockHash('b@haw-hamburg.de', s))
})

test('refuses an empty secret', () => {
    expect(() => blockHash('a@haw-hamburg.de', '')).toThrow()
})
