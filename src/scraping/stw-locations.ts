import { load } from 'cheerio'

export type StwLanguage = 'de' | 'en'

export interface StwLocation {
    id: string
    name: string
    campus: 'Berliner Tor' | 'Bergedorf' | 'Finkenau'
    url: { de: string; en: string }
    hasMenu: boolean
}

const DE = 'https://www.stwhh.de/gastronomie/mensen-cafes-weiteres/mensa/'
const EN =
    'https://www.stwhh.de/en/gastronomie/cafeterias-cafes-other/cafeteria/'

// Allow-list: the only pages ever requested. No URL comes from user input.
export const STW_LOCATIONS: readonly StwLocation[] = [
    {
        id: 'BerlinerTorMensa',
        name: 'Cafeteria Berliner Tor',
        campus: 'Berliner Tor',
        url: {
            de: `${DE}mensa-berliner-tor`,
            en: `${EN}cafeteria-berliner-tor`
        },
        hasMenu: true
    },
    {
        id: 'BerlinerTorCafe',
        name: 'Café Berliner Tor',
        campus: 'Berliner Tor',
        url: { de: `${DE}cafe-berliner-tor`, en: `${EN}cafe-berliner-tor` },
        hasMenu: false
    },
    {
        id: 'BlueberryCafe',
        name: 'Café Blueberry',
        campus: 'Berliner Tor',
        url: { de: `${DE}cafe-blueberry`, en: `${EN}cafe-blueberry` },
        hasMenu: false
    },
    {
        id: 'AlexanderstrasseCafe',
        name: 'Café Alexanderstraße',
        campus: 'Berliner Tor',
        url: {
            de: `${DE}cafe-alexanderstrasse`,
            en: `${EN}cafe-alexanderstrasse`
        },
        hasMenu: false
    },
    {
        id: 'BergedorfMensa',
        name: 'Cafeteria Bergedorf',
        campus: 'Bergedorf',
        url: { de: `${DE}mensa-bergedorf`, en: `${EN}cafeteria-bergedorf` },
        hasMenu: true
    },
    {
        id: 'FinkenauMensa',
        name: 'Cafeteria Finkenau',
        campus: 'Finkenau',
        url: { de: `${DE}mensa-finkenau`, en: `${EN}cafeteria-finkenau` },
        hasMenu: true
    },
    {
        id: 'FinkenauCafe',
        name: 'Café Finkenau',
        campus: 'Finkenau',
        url: { de: `${DE}cafe-finkenau`, en: `${EN}cafe-finkenau` },
        hasMenu: false
    }
]

export interface ParsedOpening {
    weekdays: number[]
    open: string
    close: string
}
export interface LocationOpeningLine {
    days: string
    time: string
    parsed: ParsedOpening | null
}
export interface StwLocationPage {
    name: string
    description: string
    offers: { key: string; title: string }[]
    address: string[]
    general: LocationOpeningLine[]
    distribution: LocationOpeningLine[]
}

const clean = (value: string) => value.replace(/\s+/g, ' ').trim()

const OFFER_KEYS: Record<string, string> = {
    '_Fruehstueck.svg': 'breakfast',
    'Warme_Speisen_2024.svg': 'hot-dishes',
    'WarmeSnacks_Kumpir_2024.svg': 'warm-snacks',
    'HappyHour_2024.svg': 'happy-hour',
    'Sitzplaetze_2024.svg': 'seats',
    'Kinderstuhl_2024.svg': 'highchairs',
    'Barrierefrei_2024.svg': 'barrier-free',
    'PastaBar.svg': 'pasta-bar',
    'Salatbar.svg': 'salad-bar',
    'Gemuesebar.svg': 'vegetable-bar',
    'GemueseBar.svg': 'vegetable-bar',
    'Pizza.svg': 'pizza'
}

export function offerKey(iconFile: string, title: string): string {
    const known = OFFER_KEYS[iconFile]
    if (known) return known
    return title
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .replace(/ß/g, 'ss')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
}

const WEEKDAYS: Record<StwLanguage, string[]> = {
    de: [
        'montag',
        'dienstag',
        'mittwoch',
        'donnerstag',
        'freitag',
        'samstag',
        'sonntag'
    ],
    en: [
        'monday',
        'tuesday',
        'wednesday',
        'thursday',
        'friday',
        'saturday',
        'sunday'
    ]
}

const pad = (n: number) => String(n).padStart(2, '0')

function parseDays(days: string, language: StwLanguage): number[] | null {
    const names = WEEKDAYS[language]
    const day = (name: string) => {
        const index = names.indexOf(name.trim().toLowerCase())
        return index === -1 ? null : index + 1
    }
    const text = clean(days)
    const range = text.split(language === 'de' ? /\s+bis\s+/i : /\s+to\s+/i)
    if (range.length === 2) {
        const from = day(range[0])
        const to = day(range[1])
        if (from === null || to === null) return null
        const result: number[] = []
        for (let d = from; ; d = (d % 7) + 1) {
            result.push(d)
            if (d === to) break
        }
        return result
    }
    if (range.length === 1) {
        const single = day(text)
        return single === null ? null : [single]
    }
    return null
}

function parseTime(
    time: string,
    language: StwLanguage
): { open: string; close: string } | null {
    const text = clean(time)
    if (language === 'de') {
        const m = /^(\d{1,2}):(\d{2}) bis (\d{1,2}):(\d{2})(?: Uhr)?$/.exec(
            text
        )
        if (!m) return null
        const [h1, m1, h2, m2] = [m[1], m[2], m[3], m[4]].map(Number)
        if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) return null
        return { open: `${pad(h1)}:${pad(m1)}`, close: `${pad(h2)}:${pad(m2)}` }
    }
    const m =
        /^(\d{1,2}):(\d{2}) ([ap])\.m\. to (\d{1,2}):(\d{2}) ([ap])\.m\.$/i.exec(
            text
        )
    if (!m) return null
    const to24 = (h: number, mer: string) =>
        (h % 12) + (mer.toLowerCase() === 'p' ? 12 : 0)
    const [h1, m1, h2, m2] = [m[1], m[2], m[4], m[5]].map(Number)
    if (h1 < 1 || h1 > 12 || h2 < 1 || h2 > 12 || m1 > 59 || m2 > 59)
        return null
    return {
        open: `${pad(to24(h1, m[3]))}:${pad(m1)}`,
        close: `${pad(to24(h2, m[6]))}:${pad(m2)}`
    }
}

// Anything not understood is null: the app then shows no open/closed hint.
export function parseOpening(
    days: string,
    time: string,
    language: StwLanguage
): ParsedOpening | null {
    const weekdays = parseDays(days, language)
    const range = parseTime(time, language)
    if (!weekdays || !range || range.close <= range.open) return null
    return { weekdays, ...range }
}

const pairs = (
    lines: string[],
    language: StwLanguage
): LocationOpeningLine[] => {
    const result: LocationOpeningLine[] = []
    for (let i = 0; i + 1 < lines.length; i += 2)
        result.push({
            days: lines[i],
            time: lines[i + 1],
            parsed: parseOpening(lines[i], lines[i + 1], language)
        })
    return result
}

export function parseStwLocation(
    html: string,
    language: StwLanguage
): StwLocationPage | null {
    const $ = load(html)
    const detail = $('.tx-epwerkbuilding-properties-view-detail').first()
    if (!detail.length) return null
    const name = clean(detail.find('h2 > span').first().text())
    if (!name) return null

    const description = detail
        .find('.opening-text p')
        .toArray()
        .map((p) => clean($(p).text()))
        .filter(Boolean)
        .join('\n\n')

    const offers: StwLocationPage['offers'] = []
    detail.find('.tx-epwerkbuilding-offers .title').each((_, el) => {
        const title = clean($(el).text())
        if (!title) return
        const src = $(el).closest('.row').find('img').first().attr('src') ?? ''
        offers.push({
            key: offerKey(src.split('/').pop() ?? '', title),
            title
        })
    })

    const addressBox = detail.find('.addressWrapper').first().clone()
    addressBox.find('.address').remove()
    const address = (addressBox.html() ?? '')
        .replace(/<\/b>/gi, '<br>')
        .split(/<br\s*\/?>/i)
        .map((part) => clean(load(`<p>${part}</p>`).text()))
        .filter(Boolean)

    const generalLines: string[] = []
    const distributionLines: string[] = []
    detail.find('.single-openinghour').each((_, group) => {
        const label = clean($(group).find('.openinghour-type').first().text())
        // Other labelled groups (Pizza/Pasta, ...) are not general hours.
        if (label && !/^(Allgemein|General)$/i.test(label)) return
        // An unlabelled group may continue the general hours with another day
        // range (Café Alexanderstraße) or be an unlabelled side counter (the
        // English Pizza/Pasta hours). It is kept only for days not already
        // covered, so a side counter never adds or overrides hours.
        const continuation = !label
        const own: string[] = []
        let target = continuation ? own : generalLines
        let buffer = ''
        const flush = () => {
            const line = clean(buffer)
            if (line) target.push(line)
            buffer = ''
        }
        for (const node of $(group).contents().toArray()) {
            if (node.type === 'text') buffer += $(node).text()
            else if (node.type === 'tag' && node.name === 'br') flush()
            else if (node.type === 'tag' && node.name === 'span') {
                if ($(node).hasClass('food-distribution')) {
                    flush()
                    target = distributionLines
                }
            }
        }
        flush()
        if (continuation) {
            const covered = new Set(
                pairs(generalLines, language).flatMap(
                    (line) => line.parsed?.weekdays ?? []
                )
            )
            const extra = pairs(own, language)
            const overlaps = extra.some((line) =>
                line.parsed?.weekdays.some((d) => covered.has(d))
            )
            if (!overlaps) generalLines.push(...own)
        }
    })

    return {
        name,
        description,
        offers,
        address,
        general: pairs(generalLines, language),
        distribution: pairs(distributionLines, language)
    }
}
