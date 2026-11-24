import { describe, expect, test } from 'bun:test'
import { buildSchema, parse, validate } from 'graphql'
import {
    aliasLimit,
    createRateLimiter,
    depthLimit,
    jsonLimitFor,
    MAX_ALIASES,
    MAX_QUERY_DEPTH
} from '../graphql-limits'

const schema = buildSchema(`
    type Node { name: String child: Node }
    type Query { node: Node }
`)

const nested = (levels: number) =>
    `{ ${'node { '.repeat(1)}${'child { '.repeat(levels - 2)}name${' }'.repeat(levels - 1)} }`

const errorsFor = (query: string) =>
    validate(schema, parse(query), [depthLimit(MAX_QUERY_DEPTH)])

const aliases = (count: number) =>
    `{ ${Array.from({ length: count }, (_, i) => `a${i}: node { name }`).join(' ')} }`

const aliasErrorsFor = (query: string) =>
    validate(schema, parse(query), [aliasLimit(MAX_ALIASES)])

describe('aliasLimit', () => {
    test('accepts as many aliases as the limit', () => {
        expect(aliasErrorsFor(aliases(MAX_ALIASES))).toHaveLength(0)
    })

    test('rejects one alias more', () => {
        const errors = aliasErrorsFor(aliases(MAX_ALIASES + 1))
        expect(errors).toHaveLength(1)
        expect(errors[0]?.message).toBe('TooManyAliases')
    })

    test('counts aliases each time a fragment is spread', () => {
        const query = `
            query { ${Array.from({ length: 11 }, (_, i) => `n${i}: node { ...Many }`).join(' ')} }
            fragment Many on Node { ${Array.from({ length: 5 }, (_, i) => `c${i}: name`).join(' ')} }
        `
        expect(aliasErrorsFor(query)).toHaveLength(1)
    })

    test('ignores plain fields without an alias', () => {
        expect(aliasErrorsFor('{ node { name child { name } } }')).toHaveLength(
            0
        )
    })
})

describe('depthLimit', () => {
    test('accepts a query as deep as the limit', () => {
        expect(errorsFor(nested(MAX_QUERY_DEPTH))).toHaveLength(0)
    })

    test('rejects a query one level deeper', () => {
        const errors = errorsFor(nested(MAX_QUERY_DEPTH + 1))
        expect(errors).toHaveLength(1)
        expect(errors[0]?.message).toBe('QueryTooDeep')
    })

    test('counts the depth inside fragments', () => {
        const query = `
            query { node { ...Deep } }
            fragment Deep on Node { ${'child { '.repeat(MAX_QUERY_DEPTH)}name${' }'.repeat(MAX_QUERY_DEPTH)} }
        `
        expect(errorsFor(query)).toHaveLength(1)
    })
})

describe('jsonLimitFor', () => {
    test('anonymous requests get the small limit', () => {
        expect(jsonLimitFor({})).toBe('100kb')
    })

    test('signed-in requests (cookie or token) may send calendar syncs', () => {
        expect(jsonLimitFor({ cookie: 'a=b' })).toBe('5mb')
        expect(jsonLimitFor({ authorization: 'Bearer x' })).toBe('5mb')
    })
})

describe('createRateLimiter', () => {
    test('allows the budget per key, then refuses until the window passes', () => {
        let now = 0
        const limit = createRateLimiter({
            max: 3,
            windowMs: 1000,
            now: () => now
        })
        expect([limit('a'), limit('a'), limit('a'), limit('a')]).toEqual([
            true,
            true,
            true,
            false
        ])
        expect(limit('b')).toBe(true)
        now = 1001
        expect(limit('a')).toBe(true)
    })

    test('a window that ran out restarts even between sweeps', () => {
        let now = 0
        const limit = createRateLimiter({
            max: 1,
            windowMs: 100,
            now: () => now
        })
        expect(limit('a')).toBe(true)
        now = 500
        expect(limit('b')).toBe(true)
        now = 600
        expect(limit('a')).toBe(true)
        expect(limit('a')).toBe(false)
    })

    test('stops tracking new keys at its size cap instead of growing', () => {
        const limit = createRateLimiter({
            max: 5,
            windowMs: 1000,
            maxKeys: 2,
            now: () => 0
        })
        expect(limit('a')).toBe(true)
        expect(limit('b')).toBe(true)
        expect(limit('c')).toBe(false)
    })
})
