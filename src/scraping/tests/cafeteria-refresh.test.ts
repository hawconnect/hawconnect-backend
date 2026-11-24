import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createCafeteriasQuery } from '../../queries/cafeterias'
import {
    type CafeteriaSnapshot,
    createCafeteriaService
} from '../../utils/cafeteria-refresh'
import { STW_LOCATIONS } from '../stw-locations'

const fixtures = new Map<string, string>()
for (const location of STW_LOCATIONS)
    for (const language of ['de', 'en'] as const)
        fixtures.set(
            location.url[language],
            readFileSync(
                new URL(
                    `../fixtures/stw-locations/${location.id}-${language}.html`,
                    import.meta.url
                ),
                'utf8'
            )
        )

const urlOf = (id: string, language: 'de' | 'en') => {
    const location = STW_LOCATIONS.find((l) => l.id === id)
    if (!location) throw Error(`unknown ${id}`)
    return location.url[language]
}

// Fake deps: serve the Task 1 fixtures, never the network.
const setup = (failing: Set<string> = new Set()) => {
    let clock = new Date('2026-11-23T08:00:00Z')
    let disk: CafeteriaSnapshot | null = null
    const requested: string[] = []
    const service = createCafeteriaService({
        fetchPage: async (url) => {
            requested.push(url)
            if (failing.has(url)) throw Error('offline')
            const html = fixtures.get(url)
            if (!html) throw Error(`not in allow-list: ${url}`)
            return html
        },
        read: async () => disk,
        write: async (snapshot) => {
            disk = snapshot
        },
        now: () => clock
    })
    return {
        service,
        failing,
        requested,
        disk: () => disk,
        setClock: (date: Date) => {
            clock = date
        }
    }
}

it('returns the seven places in allow-list order', async () => {
    const { service } = setup()
    await service.refresh()
    const places = await service.get('en')
    expect(places.map((p) => p.id)).toEqual(STW_LOCATIONS.map((l) => l.id))
    expect(places.every((p) => p.available)).toBe(true)
    expect(places.every((p) => !p.germanOnly)).toBe(true)
    const blueberry = places.find((p) => p.id === 'BlueberryCafe')
    expect(blueberry?.name).toBe('Café Blueberry')
    expect(blueberry?.campus).toBe('Berliner Tor')
    expect(blueberry?.sourceUrl).toBe(urlOf('BlueberryCafe', 'en'))
    expect(blueberry?.updatedAt).toBe('2026-11-23T08:00:00.000Z')
    expect(blueberry?.general[0]).toEqual({
        days: 'Monday to Thursday',
        time: '07:45 a.m. to 05:00 p.m.',
        parsed: { weekdays: [1, 2, 3, 4], open: '07:45', close: '17:00' }
    })
})

it('serves the German page and URL for language de', async () => {
    const { service } = setup()
    await service.refresh()
    const mensa = (await service.get('de')).find(
        (p) => p.id === 'BerlinerTorMensa'
    )
    expect(mensa?.sourceUrl).toBe(urlOf('BerlinerTorMensa', 'de'))
    expect(mensa?.general[0].days).toBe('Montag bis Freitag')
})

it('marks the three menu places with hasMenu', async () => {
    const { service } = setup()
    await service.refresh()
    const places = await service.get('en')
    expect(places.filter((p) => p.hasMenu).map((p) => p.id)).toEqual([
        'BerlinerTorMensa',
        'BergedorfMensa',
        'FinkenauMensa'
    ])
})

it('keeps the last good copy and its updatedAt when one page fails later', async () => {
    const { service, failing, setClock } = setup()
    await service.refresh()
    const first = (await service.get('en')).find(
        (p) => p.id === 'BlueberryCafe'
    )
    failing.add(urlOf('BlueberryCafe', 'en'))
    setClock(new Date('2026-11-23T14:00:00Z'))
    await service.refresh()
    const places = await service.get('en')
    const blueberry = places.find((p) => p.id === 'BlueberryCafe')
    expect(blueberry).toEqual(first)
    expect(blueberry?.updatedAt).toBe('2026-11-23T08:00:00.000Z')
    expect(blueberry?.germanOnly).toBe(false)
    // The other places were refreshed.
    expect(places.find((p) => p.id === 'BerlinerTorCafe')?.updatedAt).toBe(
        '2026-11-23T14:00:00.000Z'
    )
})

it('a page that never loaded is unavailable while the others still show', async () => {
    const id = 'FinkenauCafe'
    const { service } = setup(new Set([urlOf(id, 'de'), urlOf(id, 'en')]))
    await service.refresh()
    const places = await service.get('en')
    expect(places).toHaveLength(7)
    expect(places.find((p) => p.id === id)).toEqual({
        id,
        name: 'Café Finkenau',
        campus: 'Finkenau',
        available: false,
        updatedAt: null,
        germanOnly: false,
        description: null,
        offers: [],
        address: [],
        general: [],
        distribution: [],
        sourceUrl: urlOf(id, 'en'),
        hasMenu: false
    })
    expect(places.filter((p) => p.id !== id).every((p) => p.available)).toBe(
        true
    )
})

it('falls back to German content with germanOnly when the English page never loaded', async () => {
    const { service } = setup(new Set([urlOf('BerlinerTorCafe', 'en')]))
    await service.refresh()
    const cafe = (await service.get('en')).find(
        (p) => p.id === 'BerlinerTorCafe'
    )
    expect(cafe?.available).toBe(true)
    expect(cafe?.germanOnly).toBe(true)
    expect(cafe?.general[0].days).toBe('Montag bis Donnerstag')
    expect(cafe?.general[0].parsed).toEqual({
        weekdays: [1, 2, 3, 4],
        open: '07:45',
        close: '18:00'
    })
    expect(cafe?.sourceUrl).toBe(urlOf('BerlinerTorCafe', 'en'))
    const german = (await service.get('de')).find(
        (p) => p.id === 'BerlinerTorCafe'
    )
    expect(german?.germanOnly).toBe(false)
})

it('drops parsed general hours in both languages when German and English disagree', async () => {
    const { service } = setup()
    await service.refresh()
    for (const language of ['de', 'en'] as const) {
        const alex = (await service.get(language)).find(
            (p) => p.id === 'AlexanderstrasseCafe'
        )
        expect(alex?.available).toBe(true)
        expect(alex?.general.length).toBe(2)
        expect(alex?.general.every((line) => line.parsed === null)).toBe(true)
        expect(alex?.distribution.every((line) => line.parsed === null)).toBe(
            true
        )
    }
    const en = (await service.get('en')).find(
        (p) => p.id === 'AlexanderstrasseCafe'
    )
    const de = (await service.get('de')).find(
        (p) => p.id === 'AlexanderstrasseCafe'
    )
    // Text stays as published per language; Thursday stays missing in English.
    expect(en?.general.map((l) => l.days)).toEqual([
        'Monday to Wednesday',
        'Friday'
    ])
    expect(de?.general.map((l) => l.days)).toEqual([
        'Montag bis Mittwoch',
        'Donnerstag bis Freitag'
    ])
})

it('compares general and distribution hours separately', async () => {
    const { service } = setup()
    await service.refresh()
    for (const language of ['de', 'en'] as const) {
        const finkenau = (await service.get(language)).find(
            (p) => p.id === 'FinkenauMensa'
        )
        // General hours agree in both languages and keep their values.
        expect(finkenau?.general.map((l) => l.parsed)).toEqual([
            { weekdays: [1, 2, 3, 4], open: '11:30', close: '14:45' },
            { weekdays: [5], open: '11:30', close: '14:30' }
        ])
        // Distribution hours differ (14:30/14:00 vs 14:45/14:30).
        expect(finkenau?.distribution.length).toBe(2)
        expect(
            finkenau?.distribution.every((line) => line.parsed === null)
        ).toBe(true)
    }
})

it('keeps every parsed value when both groups agree', async () => {
    const { service } = setup()
    await service.refresh()
    for (const language of ['de', 'en'] as const) {
        const mensa = (await service.get(language)).find(
            (p) => p.id === 'BergedorfMensa'
        )
        expect(mensa?.general.map((l) => l.parsed)).toEqual([
            { weekdays: [1, 2, 3, 4], open: '11:15', close: '14:30' },
            { weekdays: [5], open: '11:15', close: '14:00' }
        ])
        expect(mensa?.distribution.map((l) => l.parsed)).toEqual([
            { weekdays: [1, 2, 3, 4], open: '11:15', close: '14:00' },
            { weekdays: [5], open: '11:15', close: '14:00' }
        ])
        const cafe = (await service.get(language)).find(
            (p) => p.id === 'BerlinerTorCafe'
        )
        expect(cafe?.general.map((l) => l.parsed)).toEqual([
            { weekdays: [1, 2, 3, 4], open: '07:45', close: '18:00' },
            { weekdays: [5], open: '07:45', close: '17:00' }
        ])
    }
})

it('restores the persisted snapshot after a restart without fetching', async () => {
    const first = setup()
    await first.service.refresh()
    const disk = first.disk()
    let fetched = 0
    const restarted = createCafeteriaService({
        fetchPage: async () => {
            fetched++
            throw Error('offline')
        },
        read: async () => disk,
        write: async () => {},
        now: () => new Date('2026-11-24T08:00:00Z')
    })
    const places = await restarted.get('en')
    expect(fetched).toBe(0)
    expect(places.every((p) => p.available)).toBe(true)
})

it('coalesces concurrent refreshes and only requests allow-listed pages', async () => {
    const { service, requested } = setup()
    await Promise.all([service.refresh(), service.refresh()])
    expect(requested).toHaveLength(14)
    expect(new Set(requested)).toEqual(new Set(fixtures.keys()))
})

it('backs off for 60 s after a failed cold refresh', async () => {
    const { service, failing, requested, setClock } = setup(
        new Set(fixtures.keys())
    )
    const first = await service.get('en')
    expect(first.every((p) => !p.available)).toBe(true)
    expect(requested).toHaveLength(14)

    setClock(new Date('2026-11-23T08:00:59Z'))
    const second = await service.get('en')
    expect(second.every((p) => !p.available)).toBe(true)
    expect(requested).toHaveLength(14)

    failing.clear()
    setClock(new Date('2026-11-23T08:01:00Z'))
    const third = await service.get('en')
    expect(requested).toHaveLength(28)
    expect(third.every((p) => p.available)).toBe(true)
})

it('cafeterias query validates the language', async () => {
    const { service } = setup()
    const query = createCafeteriasQuery(service)
    expect(await query(null, {})).toHaveLength(7)
    expect((await query(null, { language: 'en' }))[0].sourceUrl).toBe(
        urlOf('BerlinerTorMensa', 'en')
    )
    await expect(query(null, { language: 'fr' })).rejects.toThrow()
})
