import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
    HAW_NEWS_SOURCES,
    type HawNewsItem,
    type HawNewsLanguage,
    parseHawNews,
    withArticleImages
} from '@/scraping/haw-news'

interface Snapshot {
    items: HawNewsItem[]
    updatedAt: string
}
const refreshMs = 3600000

function validItem(item: unknown): item is HawNewsItem {
    if (!item || typeof item !== 'object') return false
    const n = item as HawNewsItem
    const https = (value: unknown) => {
        try {
            return (
                typeof value === 'string' &&
                new URL(value).origin === 'https://www.haw-hamburg.de'
            )
        } catch {
            return false
        }
    }
    return (
        typeof n.id === 'string' &&
        typeof n.title === 'string' &&
        !!n.title &&
        https(n.url) &&
        (n.teaser === null || typeof n.teaser === 'string') &&
        typeof n.date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(n.date) &&
        Array.isArray(n.categories) &&
        n.categories.every((c) => typeof c === 'string') &&
        (n.imageUrl === null || https(n.imageUrl)) &&
        (n.imageCredit === null || typeof n.imageCredit === 'string')
    )
}

/** One language's news, refreshed hourly; the last good copy survives outages. */
export function createHawNewsService(deps: {
    fetch: () => Promise<HawNewsItem[]>
    read: () => Promise<unknown>
    write: (s: Snapshot) => Promise<void>
    now: () => Date
}) {
    let snapshot: Snapshot | null = null
    let loaded = false
    let failed = false
    let pending: Promise<void> | null = null
    let nextReadAttempt = 0
    const load = async () => {
        if (loaded) return
        loaded = true
        try {
            const value = (await deps.read()) as Snapshot
            if (
                Array.isArray(value?.items) &&
                Number.isFinite(Date.parse(value.updatedAt)) &&
                value.items.every(validItem)
            )
                snapshot = value
        } catch {
            /* First run has no cache. */
        }
    }
    const refresh = (): Promise<void> => {
        if (pending) return pending
        pending = (async () => {
            await load()
            nextReadAttempt = deps.now().getTime() + 60000
            try {
                const candidate = {
                    items: await deps.fetch(),
                    updatedAt: deps.now().toISOString()
                }
                await deps.write(candidate)
                snapshot = candidate
                failed = false
            } catch {
                failed = true
                console.warn(
                    'HAW news refresh failed; retaining validated cache'
                )
            }
        })().finally(() => {
            pending = null
        })
        return pending
    }
    const get = async () => {
        await load()
        if (!snapshot && deps.now().getTime() >= nextReadAttempt)
            await refresh()
        const now = deps.now().getTime()
        return {
            items: snapshot?.items ?? [],
            updatedAt: snapshot?.updatedAt ?? null,
            available: snapshot !== null,
            stale:
                failed ||
                !snapshot ||
                now - Date.parse(snapshot.updatedAt) > refreshMs
        }
    }
    return { get, refresh }
}

async function fetchHtml(url: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const response = await fetch(url, {
                redirect: 'error',
                signal: AbortSignal.timeout(15000),
                headers: {
                    'User-Agent':
                        'HAWConnect/0.1 (student-maintained campus project)'
                }
            })
            if (!response.ok) throw Error('HAW news source unavailable')
            const html = await response.text()
            if (html.length > 2000000) throw Error('HAW news source too large')
            return html
        } catch {
            if (attempt === 1) throw Error('HAW news source unavailable')
            await new Promise((resolve) => setTimeout(resolve, 1000))
        }
    }
    throw Error('HAW news source unavailable')
}

const cacheDir = path.resolve(
    process.env.HAWCONNECT_NEWS_SNAPSHOT_DIR ?? '.cache'
)
function serviceFor(language: HawNewsLanguage) {
    const file = path.join(cacheDir, `haw-news-${language}.json`)
    // Listing thumbnail -> article image, so each article is opened only once.
    let known = new Map<string, string>()
    return createHawNewsService({
        fetch: async () => {
            const items = parseHawNews(
                await fetchHtml(HAW_NEWS_SOURCES[language]),
                HAW_NEWS_SOURCES[language]
            )
            const next = new Map<string, string>()
            for (const item of items) {
                const large = item.imageUrl && known.get(item.imageUrl)
                if (item.imageUrl && large) next.set(item.imageUrl, large)
            }
            // Only the current listing's images are remembered.
            known = next
            return withArticleImages(items, fetchHtml, known)
        },
        read: async () => JSON.parse(await readFile(file, 'utf8')),
        write: async (s) => {
            await mkdir(path.dirname(file), { recursive: true })
            await writeFile(`${file}.tmp`, JSON.stringify(s))
            await rename(`${file}.tmp`, file)
        },
        now: () => new Date()
    })
}
export const hawNewsServices: Record<
    HawNewsLanguage,
    ReturnType<typeof createHawNewsService>
> = { de: serviceFor('de'), en: serviceFor('en') }

export function startHawNewsRefresh() {
    const run = () => {
        void hawNewsServices.de
            .refresh()
            .then(() => hawNewsServices.en.refresh())
    }
    run()
    const timer = setInterval(run, refreshMs)
    timer.unref()
    return () => clearInterval(timer)
}
