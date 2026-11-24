import { describe, expect, it } from 'bun:test'
import {
    canReserve,
    MARKET,
    MARKET_FIELDS,
    MARKET_PRICE,
    validateContactMessage,
    validatePhotoIds,
    validatePostInput,
    validateReport
} from '../validation'

const base = {
    type: 'request',
    category: 'jobs',
    title: 'Looking for a job',
    description: 'A student looking for a part-time job.',
    location: 'Hamburg',
    details: { jobType: 'partTime', languages: ['english'] }
}
const post = (over: Record<string, unknown> = {}) =>
    validatePostInput({ ...base, ...over })
const field = (over: Record<string, unknown>) => () => post(over)

describe('validatePostInput', () => {
    it('accepts a minimal valid post', () => {
        expect(post()).toEqual({
            type: 'request',
            category: 'jobs',
            title: 'Looking for a job',
            description: 'A student looking for a part-time job.',
            priceEur: null,
            priceFree: false,
            priceUnit: null,
            location: 'Hamburg',
            availableFrom: null,
            details: { jobType: 'partTime', languages: ['english'] }
        })
    })
    it('exposes constants', () => {
        expect(MARKET.rulesVersion).toBe(1)
        expect(MARKET.categories).toEqual(['housing', 'jobs'])
        expect(MARKET.ownerStatuses).toEqual(['active', 'reserved', 'closed'])
    })
    it('allows reserving only housing', () => {
        expect(canReserve('housing')).toBe(true)
        expect(canReserve('jobs')).toBe(false)
    })
    it('rejects non-objects', () => {
        expect(() => validatePostInput(null)).toThrow('InvalidMarketPost:input')
    })
    it('validates title length', () => {
        expect(field({ title: 'ab' })).toThrow('InvalidMarketPost:title')
        expect(field({ title: 'a'.repeat(81) })).toThrow(
            'InvalidMarketPost:title'
        )
        expect(post({ title: 'a'.repeat(80) }).title.length).toBe(80)
    })
    it('validates description length', () => {
        expect(field({ description: 'a'.repeat(9) })).toThrow(
            'InvalidMarketPost:description'
        )
        expect(field({ description: 'a'.repeat(2001) })).toThrow(
            'InvalidMarketPost:description'
        )
        expect(post({ description: 'a'.repeat(2000) })).toBeTruthy()
    })
    it('trims, strips control chars and keeps <tags> verbatim', () => {
        const p = post({
            title: '  Hi\u0000 <b>there</b>  ',
            description: 'line one\nline\u0007 two <script>x</script>'
        })
        expect(p.title).toBe('Hi <b>there</b>')
        expect(p.description).toBe('line one\nline two <script>x</script>')
    })
    it('validates price range and integer', () => {
        expect(field({ priceEur: 100001 })).toThrow(
            'InvalidMarketPost:priceEur'
        )
        expect(field({ priceEur: -1 })).toThrow('InvalidMarketPost:priceEur')
        expect(field({ priceEur: 1.5 })).toThrow('InvalidMarketPost:priceEur')
        expect(post({ priceEur: 0 }).priceEur).toBe(0)
        expect(post({ priceEur: 100000 }).priceEur).toBe(100000)
        expect(post({ priceEur: 5 }).priceUnit).toBe('perHour')
    })
    it('rejects unknown enums', () => {
        expect(field({ type: 'x' })).toThrow('InvalidMarketPost:type')
        expect(field({ category: 'x' })).toThrow('InvalidMarketPost:category')
        expect(field({ priceUnit: 'x' })).toThrow('InvalidMarketPost:priceUnit')
    })
    it('validates location', () => {
        expect(field({ location: 'a'.repeat(61) })).toThrow(
            'InvalidMarketPost:location'
        )
        expect(post({ location: '  Hamburg ' }).location).toBe('Hamburg')
        expect(field({ location: '   ' })).toThrow('InvalidMarketPost:location')
    })
    it('validates availableFrom', () => {
        expect(post({ availableFrom: '2026-12-01' }).availableFrom).toBe(
            '2026-12-01'
        )
        expect(field({ availableFrom: '2026-02-30' })).toThrow(
            'InvalidMarketPost:availableFrom'
        )
        expect(field({ availableFrom: '01.12.2026' })).toThrow(
            'InvalidMarketPost:availableFrom'
        )
    })
})

const job = (details: Record<string, unknown>, over = {}) => ({
    type: 'offer',
    category: 'jobs',
    title: 'Tutor wanted',
    description: 'Help students with maths.',
    location: 'Hamburg',
    details: {
        employer: 'HAW',
        jobType: 'partTime',
        workMode: 'hybrid',
        languages: ['english'],
        applyMethod: 'url',
        applyUrl: 'https://haw.de/jobs',
        ...details
    },
    ...over
})
const housing = (details: Record<string, unknown> = {}, over = {}) => ({
    type: 'offer',
    category: 'housing',
    title: 'Room in Bergedorf',
    description: 'Bright room close to campus.',
    location: 'Bergedorf',
    availableFrom: '2026-12-01',
    priceEur: 450,
    details: {
        housingType: 'privateRoom',
        rentalDuration: 'long',
        ...details
    },
    ...over
})

describe('validatePostInput details', () => {
    it('accepts a complete job offer with an application URL', () => {
        const p = validatePostInput(
            job({
                weeklyHours: 20,
                requirements: ' Maths\nEnglish ',
                applyDeadline: '2026-12-31'
            })
        )
        expect(p.details).toEqual({
            employer: 'HAW',
            jobType: 'partTime',
            workMode: 'hybrid',
            languages: ['english'],
            applyMethod: 'url',
            applyUrl: 'https://haw.de/jobs',
            weeklyHours: 20,
            requirements: 'Maths\nEnglish',
            applyDeadline: '2026-12-31'
        })
    })
    it('accepts a job offer with contact name, role, email and website', () => {
        const p = validatePostInput(
            job({
                contactName: ' Ada Lovelace ',
                contactRole: 'Recruiter',
                contactEmail: 'ada@haw.de',
                companyWebsite: 'https://haw.de'
            })
        )
        expect(p.details.contactName).toBe('Ada Lovelace')
        expect(p.details.contactRole).toBe('Recruiter')
        expect(p.details.contactEmail).toBe('ada@haw.de')
        expect(p.details.companyWebsite).toBe('https://haw.de')
    })
    it('rejects a company website without https or with credentials', () => {
        for (const w of ['http://haw.de', 'https://u:p@haw.de', 'haw.de'])
            expect(() => validatePostInput(job({ companyWebsite: w }))).toThrow(
                'InvalidMarketPost:details.companyWebsite'
            )
    })
    it('rejects a malformed contact email', () => {
        expect(() =>
            validatePostInput(job({ contactEmail: 'not-an-email' }))
        ).toThrow('InvalidMarketPost:details.contactEmail')
    })
    it('rejects contact fields on a job request', () => {
        expect(() =>
            validatePostInput({
                type: 'request',
                category: 'jobs',
                title: 'Looking for work',
                description: 'Available weekdays.',
                location: 'Hamburg',
                details: { jobType: 'partTime', contactName: 'Ada' }
            })
        ).toThrow('InvalidMarketPost:details.contactName')
    })
    it('accepts a job salary per month', () => {
        const p = validatePostInput(
            job({}, { priceEur: 2000, priceUnit: 'perMonth' })
        )
        expect(p.priceEur).toBe(2000)
        expect(p.priceUnit).toBe('perMonth')
    })
    it('accepts an email application and keeps the typed case', () => {
        const p = validatePostInput(
            job({
                applyMethod: 'email',
                applyUrl: undefined,
                applyEmail: ' Jobs@Haw.de '
            })
        )
        expect(p.details.applyEmail).toBe('Jobs@Haw.de')
        expect(p.details.applyUrl).toBeUndefined()
    })
    it('omits absent and empty optional fields', () => {
        const p = validatePostInput(
            job({ requirements: '  ', weeklyHours: null })
        )
        expect('requirements' in p.details).toBe(false)
        expect('weeklyHours' in p.details).toBe(false)
    })
    it('rejects a job offer with both applyUrl and applyEmail', () => {
        expect(() =>
            validatePostInput(job({ applyEmail: 'a@haw.de' }))
        ).toThrow('InvalidMarketPost:details.applyEmail')
    })
    it('requires the apply target that matches applyMethod', () => {
        expect(() => validatePostInput(job({ applyUrl: undefined }))).toThrow(
            'InvalidMarketPost:details.applyUrl'
        )
        expect(() =>
            validatePostInput(
                job({ applyMethod: 'email', applyUrl: undefined })
            )
        ).toThrow('InvalidMarketPost:details.applyEmail')
        expect(() =>
            validatePostInput(
                job({
                    applyMethod: 'email',
                    applyUrl: undefined,
                    applyEmail: 'not-an-email'
                })
            )
        ).toThrow('InvalidMarketPost:details.applyEmail')
    })
    it('rejects applyUrl that is not https or carries credentials', () => {
        for (const applyUrl of [
            'http://x.de',
            'https://u:p@x.de',
            'https://' + 'a'.repeat(300) + '.de',
            'nonsense'
        ])
            expect(() => validatePostInput(job({ applyUrl }))).toThrow(
                'InvalidMarketPost:details.applyUrl'
            )
    })
    it('rejects a field from another category', () => {
        expect(() => validatePostInput(job({ condition: 'new' }))).toThrow(
            'InvalidMarketPost:details.condition'
        )
        expect(() => validatePostInput(job({ skills: 'x' }))).toThrow(
            'InvalidMarketPost:details.skills'
        )
    })
    it('rejects a missing required field', () => {
        expect(() =>
            validatePostInput(housing({ housingType: undefined }))
        ).toThrow('InvalidMarketPost:details.housingType')
        expect(() => validatePostInput(job({ languages: [] }))).toThrow(
            'InvalidMarketPost:details.languages'
        )
    })
    it('rejects bad values by kind', () => {
        const bad = (d: Record<string, unknown>, key: string) =>
            expect(() => validatePostInput(housing(d))).toThrow(
                `InvalidMarketPost:details.${key}`
            )
        bad({ deposit: 100001 }, 'deposit')
        bad({ deposit: -1 }, 'deposit')
        bad({ rooms: 0 }, 'rooms')
        bad({ rooms: 1.5 }, 'rooms')
        bad({ rooms: '2' }, 'rooms')
        bad({ furnished: 'maybe' }, 'furnished')
        bad({ housingType: 5 }, 'housingType')
        expect(
            validatePostInput(housing({ deposit: 0, rooms: 20 })).details
        ).toMatchObject({ deposit: 0, rooms: 20 })
    })
    it('enforces text limits', () => {
        expect(() =>
            validatePostInput(job({ employer: 'a'.repeat(81) }))
        ).toThrow('InvalidMarketPost:details.employer')
        expect(() =>
            validatePostInput(job({ requirements: 'a'.repeat(1001) }))
        ).toThrow('InvalidMarketPost:details.requirements')
        expect(
            validatePostInput(job({ requirements: 'a'.repeat(1000) })).details
                .requirements
        ).toHaveLength(1000)
    })
    it('rejects non-object details', () => {
        expect(() => validatePostInput({ ...base, details: [] })).toThrow(
            'InvalidMarketPost:details'
        )
    })
    it('rejects housing without a price', () => {
        expect(() =>
            validatePostInput(housing({}, { priceEur: undefined }))
        ).toThrow('InvalidMarketPost:priceEur')
    })
    it('fills the only price unit and rejects free where not allowed', () => {
        expect(validatePostInput(housing()).priceUnit).toBe('perMonth')
        expect(() =>
            validatePostInput(housing({}, { priceFree: true }))
        ).toThrow('InvalidMarketPost:priceFree')
        expect(() =>
            validatePostInput({ ...base, type: 'request', priceFree: true })
        ).toThrow('InvalidMarketPost:priceFree')
    })
    it('rejects a price unit the category does not allow', () => {
        expect(field({ priceEur: 5, priceUnit: 'once' })).toThrow(
            'InvalidMarketPost:priceUnit'
        )
    })
    it('requires location and availableFrom where the category needs them', () => {
        expect(() =>
            validatePostInput(job({}, { location: undefined }))
        ).toThrow('InvalidMarketPost:location')
        expect(() =>
            validatePostInput(housing({}, { availableFrom: undefined }))
        ).toThrow('InvalidMarketPost:availableFrom')
    })
    it('rejects multi values that repeat or are not options', () => {
        expect(() =>
            validatePostInput(job({ languages: ['english', 'english'] }))
        ).toThrow('InvalidMarketPost:details.languages')
        expect(() =>
            validatePostInput(job({ languages: ['klingon'] }))
        ).toThrow('InvalidMarketPost:details.languages')
        expect(() => validatePostInput(job({ languages: 'english' }))).toThrow(
            'InvalidMarketPost:details.languages'
        )
    })
    it('trims and cleans text details like the title', () => {
        const p = validatePostInput(
            job({
                employer: '  Acme\u0000 <b>GmbH</b> ',
                requirements: 'a\u0007\nb'
            })
        )
        expect(p.details.employer).toBe('Acme <b>GmbH</b>')
        expect(p.details.requirements).toBe('a\nb')
    })
    it('rejects the old campus field and the old other category', () => {
        expect(field({ category: 'other' })).toThrow(
            'InvalidMarketPost:category'
        )
        expect('campus' in post()).toBe(false)
    })
    it('pins the registry', () => {
        expect(MARKET_FIELDS).toEqual(REGISTRY)
        expect(MARKET_PRICE).toEqual(PRICES)
    })
})

describe('validatePhotoIds', () => {
    const id = () => crypto.randomUUID()
    it('accepts 0-3 uuids', () => {
        expect(validatePhotoIds(undefined)).toEqual([])
        const ids = [id(), id(), id()]
        expect(validatePhotoIds(ids)).toEqual(ids)
    })
    it('rejects more than 3, non-uuid and duplicates', () => {
        expect(() => validatePhotoIds([id(), id(), id(), id()])).toThrow(
            'InvalidMarketPost:photoIds'
        )
        expect(() => validatePhotoIds(['nope'])).toThrow(
            'InvalidMarketPost:photoIds'
        )
        const a = id()
        expect(() => validatePhotoIds([a, a])).toThrow(
            'InvalidMarketPost:photoIds'
        )
        expect(() => validatePhotoIds('x')).toThrow(
            'InvalidMarketPost:photoIds'
        )
    })
})

describe('validateContactMessage', () => {
    it('enforces 10-1000 chars', () => {
        expect(() => validateContactMessage('a'.repeat(9))).toThrow(
            'InvalidMarketMessage'
        )
        expect(() => validateContactMessage('a'.repeat(1001))).toThrow(
            'InvalidMarketMessage'
        )
        expect(() => validateContactMessage(5)).toThrow('InvalidMarketMessage')
        expect(validateContactMessage('  hello there!\u0000 ')).toBe(
            'hello there!'
        )
    })
})

describe('validateReport', () => {
    it('accepts a valid reason with optional note', () => {
        expect(validateReport({ reason: 'scam' })).toEqual({
            reason: 'scam',
            note: null
        })
        expect(validateReport({ reason: 'spam', note: ' hi ' })).toEqual({
            reason: 'spam',
            note: 'hi'
        })
    })
    it('rejects unknown reason and long note', () => {
        expect(() => validateReport({ reason: 'nope' })).toThrow(
            'InvalidMarketReport'
        )
        expect(() => validateReport(null)).toThrow('InvalidMarketReport')
        expect(() =>
            validateReport({ reason: 'spam', note: 'a'.repeat(501) })
        ).toThrow('InvalidMarketReport')
    })
})

const JOB_TYPES = [
    'fullTime',
    'partTime',
    'workingStudent',
    'internship',
    'minijob',
    'temporary'
]
const HOUSING_TYPES = ['sharedFlatRoom', 'privateRoom', 'studio', 'apartment']
const DURATIONS = ['short', 'medium', 'long', 'flexible']
const LANGUAGES = ['english', 'german', 'other']

const REGISTRY = {
    jobs: {
        offer: [
            { key: 'employer', kind: 'text', required: true },
            {
                key: 'jobType',
                kind: 'select',
                required: true,
                options: JOB_TYPES
            },
            {
                key: 'workMode',
                kind: 'select',
                required: true,
                options: ['onSite', 'hybrid', 'remote']
            },
            {
                key: 'languages',
                kind: 'multi',
                required: true,
                options: LANGUAGES
            },
            {
                key: 'weeklyHours',
                kind: 'number',
                required: false,
                min: 1,
                max: 60
            },
            { key: 'requirements', kind: 'longText', required: false },
            {
                key: 'applyMethod',
                kind: 'select',
                required: true,
                options: ['url', 'email']
            },
            { key: 'applyUrl', kind: 'url', required: false },
            { key: 'applyEmail', kind: 'email', required: false },
            { key: 'applyDeadline', kind: 'date', required: false },
            { key: 'contactName', kind: 'text', required: false },
            { key: 'contactRole', kind: 'text', required: false },
            { key: 'contactEmail', kind: 'email', required: false },
            { key: 'companyWebsite', kind: 'url', required: false }
        ],
        request: [
            {
                key: 'jobType',
                kind: 'select',
                required: true,
                options: JOB_TYPES
            },
            {
                key: 'workMode',
                kind: 'select',
                required: false,
                options: ['onSite', 'hybrid', 'remote', 'flexible']
            },
            {
                key: 'languages',
                kind: 'multi',
                required: true,
                options: LANGUAGES
            },
            { key: 'skills', kind: 'longText', required: false },
            { key: 'portfolioUrl', kind: 'url', required: false }
        ]
    },
    housing: {
        offer: [
            {
                key: 'housingType',
                kind: 'select',
                required: true,
                options: HOUSING_TYPES
            },
            {
                key: 'rentalDuration',
                kind: 'select',
                required: true,
                options: DURATIONS
            },
            {
                key: 'deposit',
                kind: 'number',
                required: false,
                min: 0,
                max: 100000
            },
            {
                key: 'rentIncludes',
                kind: 'multi',
                required: false,
                options: ['electricity', 'heating', 'internet', 'utilities']
            },
            {
                key: 'sizeSqm',
                kind: 'number',
                required: false,
                min: 1,
                max: 1000
            },
            { key: 'rooms', kind: 'number', required: false, min: 1, max: 20 },
            {
                key: 'furnished',
                kind: 'select',
                required: false,
                options: ['yes', 'no', 'partly']
            },
            {
                key: 'facilities',
                kind: 'multi',
                required: false,
                options: [
                    'washingMachine',
                    'kitchen',
                    'privateBathroom',
                    'balcony',
                    'elevator',
                    'wifi'
                ]
            }
        ],
        request: [
            {
                key: 'housingType',
                kind: 'select',
                required: true,
                options: HOUSING_TYPES
            },
            {
                key: 'rentalDuration',
                kind: 'select',
                required: false,
                options: DURATIONS
            },
            {
                key: 'furnished',
                kind: 'select',
                required: false,
                options: ['preferred', 'notNeeded', 'any']
            },
            {
                key: 'occupation',
                kind: 'select',
                required: true,
                options: ['student', 'professional', 'intern', 'other']
            },
            {
                key: 'languages',
                kind: 'multi',
                required: false,
                options: LANGUAGES
            }
        ]
    }
}

const PRICES = {
    jobs: {
        offer: { units: ['perHour', 'perMonth'], required: false, free: false },
        request: {
            units: ['perHour', 'perMonth'],
            required: false,
            free: false
        }
    },
    housing: {
        offer: { units: ['perMonth'], required: true, free: false },
        request: { units: ['perMonth'], required: true, free: false }
    }
}
