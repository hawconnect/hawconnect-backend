import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
    type LocationOpeningLine,
    type ParsedOpening,
    parseStwLocation,
    STW_LOCATIONS,
    type StwLanguage,
    type StwLocation,
    type StwLocationPage
} from '@/scraping/stw-locations'

interface StoredPage {
    page: StwLocationPage
    updatedAt: string
}
/** Last good copy of each page, per place and language. */
export interface CafeteriaSnapshot {
    places: Record<string, Partial<Record<StwLanguage, StoredPage>>>
}
export interface Cafeteria {
    id: string
    name: string
    campus: string
    available: boolean
    updatedAt: string | null
    germanOnly: boolean
    description: string | null
    offers: { key: string; title: string }[]
    address: string[]
    general: LocationOpeningLine[]
    distribution: LocationOpeningLine[]
    sourceUrl: string
    hasMenu: boolean
}
interface Dependencies {
    fetchPage: (url: string) => Promise<string>
    read: () => Promise<CafeteriaSnapshot | null>
    write: (snapshot: CafeteriaSnapshot) => Promise<void>
    now: () => Date
}

const LANGUAGES: StwLanguage[] = ['de', 'en']

const openingKey = (lines: LocationOpeningLine[]) =>
    [
        ...new Set(
            lines.map((line) =>
                line.parsed
                    ? `${[...line.parsed.weekdays].sort((a, b) => a - b).join(',')}|${line.parsed.open}|${line.parsed.close}`
                    : 'unparsed'
            )
        )
    ]
        .sort()
        .join(';')

const withoutParsed = (lines: LocationOpeningLine[]) =>
    lines.map((line) => ({ ...line, parsed: null as ParsedOpening | null }))

function toCafeteria(
    location: StwLocation,
    stored: Partial<Record<StwLanguage, StoredPage>> | undefined,
    language: StwLanguage
): Cafeteria {
    const own = stored?.[language]
    // Only English falls back to German: the German page is the source.
    const fallback = language === 'en' && !own ? stored?.de : undefined
    const chosen = own ?? fallback
    const base = {
        id: location.id,
        campus: location.campus,
        sourceUrl: location.url[language],
        hasMenu: location.hasMenu,
        germanOnly: !!fallback
    }
    if (!chosen)
        return {
            ...base,
            name: location.name,
            available: false,
            updatedAt: null,
            germanOnly: false,
            description: null,
            offers: [],
            address: [],
            general: [],
            distribution: []
        }
    const { page } = chosen
    // The two language versions describe the same opening hours. When a
    // group disagrees (Café Alexanderstraße's English general hours skip
    // Thursday) neither copy can be trusted for an open/closed hint, so that
    // group's hint is withheld in both languages.
    const checked = (group: 'general' | 'distribution') => {
        const de = stored?.de?.page[group]
        const en = stored?.en?.page[group]
        const agree = !de || !en || openingKey(de) === openingKey(en)
        return agree ? page[group] : withoutParsed(page[group])
    }
    return {
        ...base,
        name: page.name || location.name,
        available: true,
        updatedAt: chosen.updatedAt,
        description: page.description || null,
        offers: page.offers,
        address: page.address,
        general: checked('general'),
        distribution: checked('distribution')
    }
}

const isSnapshot = (value: unknown): value is CafeteriaSnapshot =>
    !!value &&
    typeof value === 'object' &&
    !!(value as CafeteriaSnapshot).places &&
    typeof (value as CafeteriaSnapshot).places === 'object'

const COLD_RETRY_MS = 60_000

export function createCafeteriaService(deps: Dependencies) {
    let snapshot: CafeteriaSnapshot | null = null
    let loaded = false
    let inFlight: Promise<void> | null = null
    let coldFailedAt: number | null = null
    const load = async () => {
        if (loaded) return
        loaded = true
        try {
            const value = await deps.read()
            if (isSnapshot(value)) snapshot = value
        } catch {
            /* An absent snapshot means every place is unavailable. */
        }
    }
    const refresh = (): Promise<void> => {
        if (inFlight) return inFlight
        inFlight = (async () => {
            await load()
            const updatedAt = deps.now().toISOString()
            const places: CafeteriaSnapshot['places'] = {}
            let fresh = 0
            await Promise.all(
                STW_LOCATIONS.flatMap((location) =>
                    LANGUAGES.map(async (language) => {
                        const previous =
                            snapshot?.places[location.id]?.[language]
                        let page: StwLocationPage | null = null
                        try {
                            page = parseStwLocation(
                                await deps.fetchPage(location.url[language]),
                                language
                            )
                        } catch {
                            page = null
                        }
                        places[location.id] ??= {}
                        // A failed or changed page keeps its last good copy.
                        const next = page ? { page, updatedAt } : previous
                        if (page) fresh++
                        if (next) places[location.id][language] = next
                    })
                )
            )
            if (!fresh) return
            const candidate = { places }
            try {
                await deps.write(candidate)
                snapshot = candidate
            } catch {
                /* Keep serving the last persisted snapshot. */
            }
        })().finally(() => {
            inFlight = null
        })
        return inFlight
    }
    const get = async (language: StwLanguage): Promise<Cafeteria[]> => {
        await load()
        // After a failed cold refresh, answer with placeholders for a while
        // instead of starting another 14-page fetch round per request.
        if (
            !snapshot &&
            (coldFailedAt === null ||
                deps.now().getTime() - coldFailedAt >= COLD_RETRY_MS)
        ) {
            await refresh()
            coldFailedAt = snapshot ? null : deps.now().getTime()
        }
        return STW_LOCATIONS.map((location) =>
            toCafeteria(location, snapshot?.places[location.id], language)
        )
    }
    return { refresh, get }
}

async function fetchPage(url: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const response = await fetch(url, {
                signal: AbortSignal.timeout(15000),
                headers: {
                    'User-Agent':
                        'HAWConnect/0.1 (+student-maintained campus project)'
                }
            })
            if (!response.ok) throw Error('Location page unavailable')
            const html = await response.text()
            if (html.length > 10_000_000) throw Error('Location page too large')
            return html
        } catch {
            if (attempt === 1) throw Error('Location page unavailable')
            await new Promise((resolve) => setTimeout(resolve, 1000))
        }
    }
    throw Error('Location page unavailable')
}

const snapshotPath = path.resolve(
    process.env.HAWCONNECT_CAFETERIA_SNAPSHOT_PATH ??
        '.cache/stw-locations.json'
)
export const cafeteriaService = createCafeteriaService({
    fetchPage,
    read: async () => JSON.parse(await readFile(snapshotPath, 'utf8')),
    write: async (snapshot) => {
        await mkdir(path.dirname(snapshotPath), { recursive: true })
        await writeFile(`${snapshotPath}.tmp`, JSON.stringify(snapshot))
        await rename(`${snapshotPath}.tmp`, snapshotPath)
    },
    now: () => new Date()
})
export function startCafeteriaRefresh() {
    void cafeteriaService.refresh()
    const interval = Number(
        process.env.HAWCONNECT_CAFETERIA_REFRESH_MS ?? 21600000
    )
    const timer = setInterval(
        () => void cafeteriaService.refresh(),
        Math.max(300000, Number.isFinite(interval) ? interval : 21600000)
    )
    timer.unref()
    return () => clearInterval(timer)
}
