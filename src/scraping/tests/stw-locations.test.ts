import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
    offerKey,
    parseOpening,
    parseStwLocation,
    STW_LOCATIONS
} from '../stw-locations'

const page = (id: string, language: 'de' | 'en') =>
    readFileSync(
        new URL(
            `../fixtures/stw-locations/${id}-${language}.html`,
            import.meta.url
        ),
        'utf8'
    )
const parse = (id: string, language: 'de' | 'en') => {
    const result = parseStwLocation(page(id, language), language)
    if (!result) throw new Error(`${id}-${language} did not parse`)
    return result
}

const germanNames: Record<string, string> = {
    BerlinerTorMensa: 'Mensa Berliner Tor',
    BergedorfMensa: 'Mensa Bergedorf',
    FinkenauMensa: 'Mensa Finkenau'
}

describe('Studierendenwerk location pages', () => {
    it('allow-lists exactly the seven places', () => {
        expect(STW_LOCATIONS.map((l) => l.id)).toEqual([
            'BerlinerTorMensa',
            'BerlinerTorCafe',
            'BlueberryCafe',
            'AlexanderstrasseCafe',
            'BergedorfMensa',
            'FinkenauMensa',
            'FinkenauCafe'
        ])
        for (const l of STW_LOCATIONS) {
            expect(
                l.url.de.startsWith('https://www.stwhh.de/gastronomie/')
            ).toBe(true)
            expect(
                l.url.en.startsWith('https://www.stwhh.de/en/gastronomie/')
            ).toBe(true)
        }
    })

    for (const location of STW_LOCATIONS) {
        for (const language of ['de', 'en'] as const) {
            it(`parses ${location.id}-${language}`, () => {
                const result = parse(location.id, language)
                expect(result.name).toBe(
                    language === 'de'
                        ? (germanNames[location.id] ?? location.name)
                        : location.name
                )
                expect(result.address.length).toBe(2)
                expect(result.general.length).toBeGreaterThan(0)
                for (const line of [...result.general, ...result.distribution])
                    expect(line.parsed).not.toBeNull()
            })
        }
    }

    it('parses Café Blueberry (en)', () => {
        const result = parse('BlueberryCafe', 'en')
        expect(result.offers).toEqual([
            { key: 'happy-hour', title: 'Happy Hour' },
            { key: 'barrier-free', title: 'barrier-free' }
        ])
        expect(result.address).toEqual(['Berliner Tor 5', '20099 Hamburg'])
        expect(result.description.startsWith('At Café Blueberry')).toBe(true)
        expect(
            result.general.map(({ days, time }) => ({ days, time }))
        ).toEqual([
            { days: 'Monday to Thursday', time: '07:45 a.m. to 05:00 p.m.' },
            { days: 'Friday', time: '07:45 a.m. to 04:00 p.m.' }
        ])
        expect(result.distribution).toEqual([])
        expect(result.general.map((l) => l.parsed)).toEqual([
            { weekdays: [1, 2, 3, 4], open: '07:45', close: '17:00' },
            { weekdays: [5], open: '07:45', close: '16:00' }
        ])
    })

    it('parses the German Blueberry page to the same hours', () => {
        const de = parse('BlueberryCafe', 'de')
        expect(de.general.map((l) => l.parsed)).toEqual(
            parse('BlueberryCafe', 'en').general.map((l) => l.parsed)
        )
        expect(de.general[0].days).toBe('Montag bis Donnerstag')
        expect(de.general[0].time).toBe('07:45 bis 17:00 Uhr')
    })

    it('parses the food distribution of Cafeteria Berliner Tor', () => {
        const en = parse('BerlinerTorMensa', 'en')
        const expected = [
            { weekdays: [1, 2, 3, 4, 5], open: '11:00', close: '14:30' }
        ]
        expect(en.distribution.map((l) => l.parsed)).toEqual(expected)
        expect(
            parse('BerlinerTorMensa', 'de').distribution.map((l) => l.parsed)
        ).toEqual(expected)
        // The separate Pizza/Pasta/Flammkuchen group is not general hours.
        expect(en.general.length).toBe(1)
    })

    it('keeps Café Alexanderstraße exactly as the English page lists it', () => {
        const en = parse('AlexanderstrasseCafe', 'en')
        expect(en.general.map((l) => l.parsed?.weekdays)).toEqual([
            [1, 2, 3],
            [5]
        ])
        expect(en.general[1].parsed).toEqual({
            weekdays: [5],
            open: '08:00',
            close: '15:00'
        })
    })

    it('reads the German Alexanderstraße page as written (Thursday to Friday)', () => {
        const de = parse('AlexanderstrasseCafe', 'de')
        expect(de.general.map((l) => l.parsed?.weekdays)).toEqual([
            [1, 2, 3],
            [4, 5]
        ])
    })

    it('understands German times with and without "Uhr"', () => {
        expect(
            parseOpening('Montag bis Freitag', '11:15 bis 14:30', 'de')
        ).toEqual({ weekdays: [1, 2, 3, 4, 5], open: '11:15', close: '14:30' })
        expect(
            parseOpening('Montag bis Freitag', '11:15 bis 14:30 Uhr', 'de')
        ).toEqual({ weekdays: [1, 2, 3, 4, 5], open: '11:15', close: '14:30' })
    })

    it('handles single-digit and noon/midnight English times', () => {
        expect(
            parseOpening('Monday to Friday', '9:00 a.m. to 4:00 p.m.', 'en')
        ).toEqual({ weekdays: [1, 2, 3, 4, 5], open: '09:00', close: '16:00' })
        expect(
            parseOpening('Monday', '12:00 p.m. to 11:30 p.m.', 'en')?.open
        ).toBe('12:00')
    })

    it('gives null for text it does not understand', () => {
        expect(parseOpening('Weekends', 'closed', 'en')).toBeNull()
        expect(
            parseOpening('Montag bis Freitag', 'geschlossen', 'de')
        ).toBeNull()
        expect(
            parseOpening('Monday to Friday', '5:00 p.m. to 9:00 a.m.', 'en')
        ).toBeNull()
        // Wrong language never guesses.
        expect(parseOpening('Montag', '07:45 bis 17:00 Uhr', 'en')).toBeNull()
    })

    it('maps offer icons explicitly and falls back to a slug', () => {
        expect(offerKey('HappyHour_2024.svg', 'Happy Hour')).toBe('happy-hour')
        expect(offerKey('Gemuesebar.svg', 'x')).toBe('vegetable-bar')
        expect(offerKey('GemueseBar.svg', 'x')).toBe('vegetable-bar')
        expect(offerKey('Unknown.svg', 'Coffee to go')).toBe('coffee-to-go')
    })

    it('returns null when the detail block is missing', () => {
        expect(
            parseStwLocation('<html><body>Oops</body></html>', 'en')
        ).toBeNull()
    })
})
