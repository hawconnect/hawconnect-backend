import { load } from 'cheerio'
export interface HamburgRecord {
    date: string
    location: string
    sourceId: string
    title: string
    category: string
    allergens: string[] | null
    additives: string[] | null
    symbols: string[] | null
    declaredFlags?: string[]
    icons?: string[]
    prices: {
        student: number | null
        employee: number | null
        guest: number | null
    }
}
export interface OpeningLine {
    days: string
    time: string
}
export interface Canteen {
    id: string
    sourceId: string
    name: string
    address: string[]
    general: OpeningLine[]
    distribution: OpeningLine[]
}
export interface HamburgMenuSnapshot {
    language: 'de' | 'en'
    records: HamburgRecord[]
    canteens: Canteen[]
    locations: string[]
    dates: string[]
}
const splitCodes = (value: string | undefined) =>
    value === undefined
        ? null
        : value.trim().split(/\s+/).filter(Boolean).sort()
const restaurants: Record<string, string> = {
    '168': 'BergedorfMensa',
    '170': 'BerlinerTorMensa',
    '164': 'FinkenauMensa'
}
const clean = (value: string) => value.replace(/\s+/g, ' ').trim()
const distributionLabel = /^(Essensausgabe|Food distribution)$/i
const restaurantId = (sourceId: string) =>
    restaurants[sourceId] ?? `Hamburg_${sourceId}`
export function parseHamburgCanteens(
    html: string,
    language: 'de' | 'en'
): Canteen[] {
    const $ = load(html)
    // Text lines of an element, split on <br>, each trimmed and collapsed.
    const lines = (el: ReturnType<typeof $>) =>
        (el.html() ?? '')
            .split(/<br\s*\/?>/i)
            .map((part) => clean(load(`<p>${part}</p>`).text()))
            .filter(Boolean)
    const canteens = new Map<string, Canteen>()
    $('[data-location-id]').each((_, section) => {
        const sourceId = $(section).attr('data-location-id') ?? ''
        if (!sourceId || canteens.has(sourceId)) return
        const modal = $(section).find(`#ModalMensaInfo${sourceId}`).first()
        const body = modal.find('.infomodal__body').first()
        const general: OpeningLine[] = []
        const distribution: OpeningLine[] = []
        const generalCards = body
            .find('.infocard')
            .filter((_, card) =>
                /^(Allgemein|General)$/i.test(
                    clean($(card).find('.infocard__headline').text())
                )
            )
        generalCards.find('.infocard__text').each((_, paragraph) => {
            const parts = lines($(paragraph))
            const label = parts.findIndex((line) =>
                distributionLabel.test(line)
            )
            const generalParts = label === -1 ? parts : parts.slice(0, label)
            // Pair a days line with the time line that follows it.
            if (generalParts.length >= 2)
                general.push({ days: generalParts[0], time: generalParts[1] })
            if (label !== -1 && generalParts.length >= 1 && parts[label + 1])
                distribution.push({
                    days: generalParts[0],
                    time: parts[label + 1]
                })
        })
        if (!general.length) {
            const raw = $(section)
                .find(`[data-location="${sourceId}"][data-openings]`)
                .first()
                .attr('data-openings')
            try {
                const openings = raw ? JSON.parse(raw).openings : []
                const to = language === 'de' ? 'bis' : 'until'
                for (const o of Array.isArray(openings) ? openings : []) {
                    if (!o?.dayFrom || !o?.timeFrom || !o?.timeTo) continue
                    general.push({
                        days: o.dayTo
                            ? `${o.dayFrom} ${to} ${o.dayTo}`
                            : String(o.dayFrom),
                        time: `${o.timeFrom} - ${o.timeTo}`
                    })
                }
            } catch {
                /* Unparseable openings stay empty rather than invented. */
            }
        }
        const address = body.find('a.infocard__link').first()
        canteens.set(sourceId, {
            id: restaurantId(sourceId),
            sourceId,
            name: clean(
                body.find('h5.h3-style').first().text() ||
                    $(section).find('.mensainfo__title').first().text()
            ),
            address: address.length ? lines(address) : [],
            general,
            distribution
        })
    })
    return [...canteens.values()]
}
export function parseHamburgMenu(
    html: string,
    language: 'de' | 'en'
): HamburgMenuSnapshot {
    const $ = load(html)
    const sections = $('[data-location-id]')
    if (!sections.length) throw new Error('Food source structure changed')
    const records = new Map<string, HamburgRecord>()
    const locations = new Set<string>()
    const dates = new Set<string>()
    sections.each((_, section) => {
        const location = $(section).attr('data-location-id') ?? ''
        locations.add(location)
        $(section)
            .find('[data-timestamp]')
            .each((_, day) => {
                const date = $(day).attr('data-timestamp') ?? ''
                if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
                    throw new Error('Invalid menu date')
                dates.add(date)
                $(day)
                    .find('.menue-tile')
                    .each((_, tile) => {
                        const el = $(tile)
                        const sourceId = el.attr('data-uid') ?? ''
                        const title = el
                            .find('.singlemeal__headline')
                            .first()
                            .text()
                            .replace(/\s+/g, ' ')
                            .trim()
                        if (!sourceId || !title)
                            throw new Error('Invalid menu record')
                        const prices: HamburgRecord['prices'] = {
                            student: null,
                            employee: null,
                            guest: null
                        }
                        el.find('dd.dlist__item').each((_, price) => {
                            const text = $(price)
                                .text()
                                .replace(/\s+/g, ' ')
                                .trim()
                            const numeric = $(price)
                                .find('.singlemeal__info--semibold')
                                .first()
                                .text()
                                .match(/(\d+(?:[,.]\d{1,2})?)\s*€/)
                            if (!numeric) return
                            const value = Number(numeric[1].replace(',', '.'))
                            if (/Studierende|Students/i.test(text))
                                prices.student = value
                            else if (/Bedienstete|Employees/i.test(text))
                                prices.employee = value
                            else if (/Gäste|Guests/i.test(text))
                                prices.guest = value
                        })
                        const record = {
                            date,
                            location,
                            sourceId,
                            title,
                            category:
                                clean(
                                    el
                                        .closest('.menulist__categorywrapper')
                                        .find('.menulist__categorytitle')
                                        .first()
                                        .text()
                                ) ||
                                el.attr('data-categories')?.trim() ||
                                '',
                            allergens: splitCodes(el.attr('data-allergens')),
                            additives: splitCodes(el.attr('data-additives')),
                            symbols: splitCodes(el.attr('data-symbols')),
                            declaredFlags: [
                                ...new Set(
                                    el
                                        .find('img[src]')
                                        .toArray()
                                        .flatMap((image) => {
                                            const filename = (
                                                $(image).attr('src') ?? ''
                                            )
                                                .split('?')[0]
                                                .split('/')
                                                .pop()
                                            const flag = (
                                                {
                                                    'beef.svg': 'R',
                                                    'pork.svg': 'S',
                                                    'alc.svg': 'A'
                                                } as Record<string, string>
                                            )[filename ?? '']
                                            return flag ? [flag] : []
                                        })
                                )
                            ],
                            icons: [
                                ...new Set(
                                    el
                                        .find('img[src]')
                                        .toArray()
                                        .flatMap((image) => {
                                            const stem = (
                                                $(image).attr('src') ?? ''
                                            ).match(
                                                /\/Icons\/MealIcons\/(?:Normal|Highlight)\/([^/?#]+)\.svg(?:[?#]|$)/
                                            )?.[1]
                                            return stem ? [stem] : []
                                        })
                                )
                            ],
                            prices
                        }
                        records.set(`${location}:${date}:${sourceId}`, record)
                    })
            })
    })
    if (!dates.size || !records.size)
        throw new Error('Unverified empty menu source')
    return {
        language,
        records: [...records.values()],
        canteens: parseHamburgCanteens(html, language),
        locations: [...locations],
        dates: [...dates]
    }
}
export function mergeHamburgMenus(
    de: HamburgMenuSnapshot,
    en: HamburgMenuSnapshot,
    verifiedPairs: Readonly<Record<string, string>> = {}
) {
    const primary = de.records.length ? de : en
    const days = new Map<string, ReturnType<typeof makeMeal>[]>()
    let translationFallback = false
    function makeMeal(r: HamburgRecord, translation?: HamburgRecord) {
        const flags =
            r.symbols?.flatMap((s) =>
                s === '38'
                    ? ['veg']
                    : s === '31'
                      ? ['V']
                      : s === '17'
                        ? ['F']
                        : s === '45'
                          ? ['favorite']
                          : []
            ) ?? null
        return {
            id: `hamburg:${r.location}:${r.date}:${r.sourceId}`,
            mealId: `hamburg:${r.location}:${r.sourceId}`,
            name: { de: r.title, en: translation?.title ?? r.title },
            category: r.category,
            prices: r.prices,
            allergens: r.allergens,
            additives: r.additives,
            flags: r.declaredFlags?.length
                ? [...new Set([...(flags ?? []), ...r.declaredFlags])]
                : flags,
            icons: r.icons ?? [],
            nutrition: null,
            variants: [],
            originalLanguage: primary.language,
            static: false,
            restaurant: restaurantId(r.location),
            parent: null
        }
    }
    for (const r of primary.records) {
        const verifiedId =
            verifiedPairs[`${r.location}:${r.date}:${r.sourceId}`]
        const match = verifiedId
            ? en.records.find(
                  (e) =>
                      e.sourceId === verifiedId &&
                      e.date === r.date &&
                      e.location === r.location
              )
            : undefined
        if (!match) translationFallback = true
        const meal = makeMeal(r, match)
        days.set(r.date, [...(days.get(r.date) ?? []), meal])
    }
    return {
        foodData: [...days]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([timestamp, meals]) => ({ timestamp, meals })),
        translationFallback,
        errors: [] as { location: string; message: string }[]
    }
}
