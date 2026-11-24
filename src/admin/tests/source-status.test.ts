import { expect, test } from 'bun:test'
import { combineSourceStatus } from '../source-status'

test('HAW News is available only when both languages are, and as fresh as the older feed', () => {
    const de = {
        available: true,
        stale: false,
        updatedAt: '2026-11-17T10:00:00.000Z'
    }
    const en = {
        available: true,
        stale: false,
        updatedAt: '2026-11-17T09:00:00.000Z'
    }
    expect(combineSourceStatus([de, en])).toEqual({
        available: true,
        stale: false,
        updatedAt: '2026-11-17T09:00:00.000Z'
    })
    expect(combineSourceStatus([de, { ...en, stale: true }]).stale).toBe(true)
    expect(
        combineSourceStatus([
            de,
            { available: false, stale: true, updatedAt: null }
        ])
    ).toEqual({ available: false, stale: true, updatedAt: null })
})
