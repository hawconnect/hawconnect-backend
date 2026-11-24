import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mergeHamburgMenus, parseHamburgMenu } from '../hamburg'

const page = (language: 'de' | 'en') =>
    readFileSync(
        new URL(`../fixtures/hamburg-${language}.html`, import.meta.url),
        'utf8'
    )

const fixture = (title: string, uid: string, price = '2,20', codes = 'Sl') =>
    `<div data-location-id="168"><h3>Mensa Bergedorf</h3><div data-timestamp="2026-10-19"><div class="menulist__categorywrapper"><h5 class="menulist__categorytitle">Pottkieker</h5><div class="menue-tile" data-uid="${uid}" data-allergens="${codes}" data-additives="2" data-symbols="38"><div class="singlemeal" data-locations="168"><h5 class="singlemeal__headline">${title}</h5><dl><dd class="dlist__item"><span class="singlemeal__info"><span class="singlemeal__info--semibold">${price} €</span> Students</span></dd></dl></div></div></div></div></div>`
it('parses source date, cafeteria, declared labels and nullable prices', () => {
    const data = parseHamburgMenu(fixture('Eintopf', '85'), 'de')
    expect(data.records[0]).toMatchObject({
        date: '2026-10-19',
        location: '168',
        sourceId: '85',
        title: 'Eintopf',
        allergens: ['Sl'],
        additives: ['2'],
        symbols: ['38'],
        prices: { student: 2.2, employee: null, guest: null }
    })
})
it('rejects changed markup rather than silently replacing a valid menu', () => {
    expect(() =>
        parseHamburgMenu('<html>Service unavailable</html>', 'de')
    ).toThrow()
})
it('joins only explicitly verified source identifier pairs', () => {
    const result = mergeHamburgMenus(
        parseHamburgMenu(fixture('Eintopf', '85'), 'de'),
        parseHamburgMenu(fixture('Stew', '597'), 'en'),
        { '168:2026-10-19:85': '597' }
    )
    expect(result.foodData[0].meals[0].name).toEqual({
        de: 'Eintopf',
        en: 'Stew'
    })
    expect(result.foodData[0].meals[0].prices.guest).toBeNull()
})
it('falls back when two different dishes share a structural signature', () => {
    const de = parseHamburgMenu(fixture('A', '1') + fixture('B', '2'), 'de')
    const en = parseHamburgMenu(fixture('X', '3') + fixture('Y', '4'), 'en')
    const result = mergeHamburgMenus(de, en)
    expect(result.foodData[0].meals[0].name.en).toBe('A')
    expect(result.translationFallback).toBe(true)
})
it('does not infer allergen safety from a missing attribute', () => {
    const data = parseHamburgMenu(
        fixture('A', '1').replace('data-allergens="Sl"', ''),
        'de'
    )
    expect(data.records[0].allergens).toBeNull()
})
it('rejects location shells with no verified menu records', () => {
    expect(() =>
        parseHamburgMenu('<div data-location-id="168"></div>', 'de')
    ).toThrow()
    expect(() =>
        parseHamburgMenu(
            '<div data-location-id="168"><div data-timestamp="2026-10-19"></div></div>',
            'de'
        )
    ).toThrow()
})
it('does not infer translations from matching metadata', () => {
    const result = mergeHamburgMenus(
        parseHamburgMenu(fixture('Karottengemüse', '1'), 'de'),
        parseHamburgMenu(fixture('Courgette vegetables', '2'), 'en')
    )
    expect(result.foodData[0].meals[0].name.en).toBe('Karottengemüse')
    expect(result.translationFallback).toBe(true)
})
it('maps declared vegan source symbol to the upstream vegan flag', () => {
    const result = mergeHamburgMenus(
        parseHamburgMenu(fixture('A', '1'), 'de'),
        parseHamburgMenu(fixture('A', '1'), 'en')
    )
    expect(result.foodData[0].meals[0].flags).toEqual(['veg'])
})

it('serves the English source independently without inferring German/English dish identity', () => {
    const de = parseHamburgMenu(fixture('Karottengemüse', '1'), 'de')
    const en = parseHamburgMenu(fixture('Courgette vegetables', '2'), 'en')
    const english = mergeHamburgMenus({ ...de, records: [] }, en)
    expect(english.foodData[0].meals[0].name.en).toBe('Courgette vegetables')
    expect(english.foodData[0].meals[0].originalLanguage).toBe('en')
    expect(english.foodData[0].meals[0].id).toBe('hamburg:168:2026-10-19:2')
})

it('maps all published Hamburg selectable symbols and ignores unknown symbols', () => {
    const html = fixture('A', '1').replace(
        'data-symbols="38"',
        'data-symbols="31 38 17 45 999"'
    )
    const result = mergeHamburgMenus(
        parseHamburgMenu(html, 'de'),
        parseHamburgMenu(html, 'en')
    )
    expect(result.foodData[0].meals[0].flags).toEqual([
        'F',
        'V',
        'veg',
        'favorite'
    ])
})

it('maps meat and alcohol only from explicit dish icons', () => {
    const html = fixture('A', '1').replace(
        '<h5 class="singlemeal__headline">',
        '<img src="/Icons/MealIcons/Normal/beef.svg"><img src="/Icons/MealIcons/Normal/pork.svg"><img src="/Icons/MealIcons/Normal/alc.svg"><h5 class="singlemeal__headline">'
    )
    const result = mergeHamburgMenus(
        parseHamburgMenu(html, 'de'),
        parseHamburgMenu(html, 'en')
    )
    expect(result.foodData[0].meals[0].flags).toEqual(['veg', 'R', 'S', 'A'])
    expect(result.foodData[0].meals[0].flags).not.toContain('Gf')
})

it('parses Bergedorf address and opening hours from the German fixture', () => {
    const { canteens } = parseHamburgMenu(page('de'), 'de')
    expect(canteens).toEqual([
        {
            id: 'BergedorfMensa',
            sourceId: '168',
            name: 'Mensa Bergedorf',
            address: ['Ulmenliet 20', '21033 Hamburg'],
            general: [
                { days: 'Montag bis Donnerstag', time: '07:45 - 14:30' },
                { days: 'Freitag', time: '07:45 - 14:00 Uhr' }
            ],
            distribution: [
                { days: 'Montag bis Donnerstag', time: '11:15 - 14:00 Uhr' },
                { days: 'Freitag', time: '11:15 - 14:00 Uhr' }
            ]
        }
    ])
})

it('keeps English wording from the English fixture', () => {
    const { canteens } = parseHamburgMenu(page('en'), 'en')
    expect(canteens).toEqual([
        {
            id: 'BergedorfMensa',
            sourceId: '168',
            name: 'Cafeteria Bergedorf',
            address: ['Ulmenliet 20', '21033 Hamburg'],
            general: [
                {
                    days: 'Monday until Thursday',
                    time: '11:15 a.m. - 02:30 p.m.'
                },
                { days: 'Friday', time: '11:15 a.m. - 02:00 p.m.' }
            ],
            distribution: [
                {
                    days: 'Monday until Thursday',
                    time: '11:15 a.m. - 02:00 p.m.'
                },
                { days: 'Friday', time: '11:15 a.m. - 02:00 p.m.' }
            ]
        }
    ])
})

it('a location without an info panel has empty address and hours', () => {
    const { canteens } = parseHamburgMenu(
        fixture('A', '1').replace(
            'data-location-id="168"',
            'data-location-id="170"'
        ),
        'de'
    )
    expect(canteens).toEqual([
        {
            id: 'BerlinerTorMensa',
            sourceId: '170',
            name: '',
            address: [],
            general: [],
            distribution: []
        }
    ])
})

it('falls back to data-openings for general hours only when the card is missing', () => {
    const html = page('de').replace(/infocard__text/g, 'x-gone')
    const [canteen] = parseHamburgMenu(html, 'de').canteens
    expect(canteen.general).toEqual([
        { days: 'Montag bis Donnerstag', time: '07:45 - 14:30' },
        { days: 'Freitag', time: '07:45 - 14:00 Uhr' }
    ])
    expect(canteen.distribution).toEqual([])
})

const iconsPage = () =>
    readFileSync(
        new URL('../fixtures/hamburg-de-icons.html', import.meta.url),
        'utf8'
    )
const iconsByMeal = () =>
    Object.fromEntries(
        parseHamburgMenu(iconsPage(), 'de').records.map((r) => [
            `${r.location}:${r.sourceId}`,
            r.icons
        ])
    )

it('parses meal icons from the markup in page order', () => {
    const icons = iconsByMeal()
    expect(icons['174:44']).toEqual(['vega', 'lact'])
    expect(icons['174:43']).toEqual(['pork', 'lact'])
    expect(icons['174:42']).toEqual(['alc', 'lact', 'vege'])
    expect(icons['174:46']).toEqual(['vege'])
    expect(icons['158:74']).toEqual(['poul', 'alc'])
    expect(icons['158:73']).toEqual(['vita', 'vega', 'lact'])
    const merged = mergeHamburgMenus(
        parseHamburgMenu(iconsPage(), 'de'),
        parseHamburgMenu(iconsPage(), 'en')
    )
    expect(
        merged.foodData
            .flatMap((day) => day.meals)
            .find((meal) => meal.id.endsWith(':42'))?.icons
    ).toEqual(['alc', 'lact', 'vege'])
})

it('reads Highlight icons and ignores unrelated images', () => {
    const html = fixture('A', '1').replace(
        '<h5 class="singlemeal__headline">',
        '<img src="/x/MealIcons/Highlight/fish.svg"><img src="/Icons/logo.svg"><img src="/Icons/MealIcons/Highlight/fish.svg"><img src="/Icons/MealIcons/Normal/fave.svg"><h5 class="singlemeal__headline">'
    )
    expect(parseHamburgMenu(html, 'de').records[0].icons).toEqual([
        'fish',
        'fave'
    ])
})

it('meal without icons has an empty list', () => {
    const data = parseHamburgMenu(fixture('A', '1'), 'de')
    expect(data.records[0].icons).toEqual([])
    expect(mergeHamburgMenus(data, data).foodData[0].meals[0].icons).toEqual([])
})

it('parses address and hours for several locations from the live page', () => {
    const { canteens } = parseHamburgMenu(iconsPage(), 'de')
    expect(canteens.map((c) => [c.id, c.name, c.address])).toEqual([
        ['Hamburg_174', 'Mensa MIN', ['Bundesstraße 56 a', '20146 Hamburg']],
        ['Hamburg_158', 'Mensa Harburg', ['Denickestraße 22', '21073 Hamburg']]
    ])
    const [first, second] = canteens
    expect(first.general).toEqual([
        { days: 'Montag bis Freitag', time: '11:00 - 15:00 Uhr' }
    ])
    expect(first.distribution).toEqual([
        { days: 'Montag bis Freitag', time: '11:00 - 14:30 Uhr' }
    ])
    expect(second.general).toEqual([
        { days: 'Montag bis Donnerstag', time: '10:30 - 16:00 Uhr' },
        { days: 'Freitag', time: '10:30 - 15:30 Uhr' }
    ])
    expect(second.distribution).toEqual([
        { days: 'Montag bis Donnerstag', time: '11:00 - 15:30 Uhr' },
        { days: 'Freitag', time: '11:00 - 15:00 Uhr' }
    ])
})

it('ignores extra infocards such as Pizza/Pasta/Flammkuchen for hours', () => {
    const card = (headline: string, text: string) =>
        `<div class="infocard"><h6 class="infocard__headline">${headline}</h6><div class="infocard__body"><p class="infocard__text">${text}</p></div></div>`
    const panel = `<div class="modal" id="ModalMensaInfo170"><div class="infomodal__body"><h5 class="h3-style">Mensa Berliner Tor</h5>${card('Allgemein', 'Montag bis Freitag<br>11:00 - 16:00 Uhr<br>Essensausgabe<br>11:00 - 14:30 Uhr')}${card('Pizza/Pasta/Flammkuchen', 'Dienstag bis Samstag<br>12:00 - 13:00 Uhr<br>Essensausgabe<br>12:15 - 12:45 Uhr')}</div></div>`
    const html = fixture('A', '1')
        .replace('data-location-id="168"', 'data-location-id="170"')
        .replace('<h3>', `${panel}<h3>`)
    const [canteen] = parseHamburgMenu(html, 'de').canteens
    expect(canteen.general).toEqual([
        { days: 'Montag bis Freitag', time: '11:00 - 16:00 Uhr' }
    ])
    expect(canteen.distribution).toEqual([
        { days: 'Montag bis Freitag', time: '11:00 - 14:30 Uhr' }
    ])
})

it('category is the category title from the page, not the internal number', () => {
    const categories = (html: string, language: 'de' | 'en') => [
        ...new Set(
            parseHamburgMenu(html, language).records.map((r) => r.category)
        )
    ]
    expect(categories(page('de'), 'de')).toContain('Pottkieker')
    expect(categories(page('en'), 'en')).toContain('Pottkieker')
    const live = categories(iconsPage(), 'de')
    expect(live.length).toBeGreaterThan(1)
    for (const category of live) expect(category).not.toMatch(/^\d+$/)
    expect(live).toEqual(
        expect.arrayContaining(['Pottkieker', 'CampusKlassiker', 'Pastabar'])
    )
    const noTitle = fixture('A', '1').replace(
        /<h5 class="menulist__categorytitle">.*?<\/h5>/,
        ''
    )
    expect(
        parseHamburgMenu(
            noTitle.replace('data-uid', 'data-categories="3 " data-uid'),
            'de'
        ).records[0].category
    ).toBe('3')
})
