import { expect, test } from 'bun:test'
import { createHawNewsService } from '../../utils/haw-news'
import type { HawNewsItem } from '../haw-news'

const item: HawNewsItem = {
    id: '/detail/news/news/show/a/',
    title: 'Sample',
    url: 'https://www.haw-hamburg.de/detail/news/news/show/a/',
    teaser: null,
    date: '2026-11-12',
    categories: [],
    imageUrl: null,
    imageCredit: null
}
function harness(fetch: () => Promise<HawNewsItem[]>, cached?: unknown) {
    let stored: unknown = cached
    let now = new Date('2026-11-13T10:00:00Z')
    const service = createHawNewsService({
        fetch,
        read: async () => {
            if (stored === undefined) throw Error('no cache')
            return stored
        },
        write: async (s) => {
            stored = s
        },
        now: () => now
    })
    return {
        service,
        stored: () => stored,
        advance: (ms: number) => {
            now = new Date(now.getTime() + ms)
        }
    }
}

test('serves freshly fetched news', async () => {
    const { service } = harness(async () => [item])

    const result = await service.get()

    expect(result.available).toBe(true)
    expect(result.items).toEqual([item])
    expect(result.stale).toBe(false)
})

test('keeps the last good news when a refresh fails', async () => {
    let fail = false
    const { service, advance } = harness(async () => {
        if (fail) throw Error('down')
        return [item]
    })
    await service.refresh()
    fail = true
    advance(2 * 3600000)

    await service.refresh()
    const result = await service.get()

    expect(result.items).toEqual([item])
    expect(result.stale).toBe(true)
})

test('reports unavailable when nothing could ever be loaded', async () => {
    const { service } = harness(async () => {
        throw Error('down')
    })

    const result = await service.get()

    expect(result.available).toBe(false)
    expect(result.items).toEqual([])
})

test('ignores a corrupted cache file', async () => {
    const { service } = harness(
        async () => {
            throw Error('down')
        },
        { items: [{ id: 1 }], updatedAt: 'nope' }
    )

    expect((await service.get()).available).toBe(false)
})
