import { normaliseAccountEmail } from '../utils/account-policy'

export const MARKET = {
    types: ['offer', 'request'],
    categories: ['housing', 'jobs'],
    ownerStatuses: ['active', 'reserved', 'closed'],
    priceUnits: ['once', 'perMonth', 'perHour'],
    reasons: [
        'scam',
        'illegal',
        'offensive',
        'discrimination',
        'spam',
        'other'
    ],
    rulesVersion: 1,
    titleMin: 3,
    titleMax: 80,
    descriptionMin: 10,
    descriptionMax: 2000,
    priceMax: 100000,
    locationMax: 60,
    maxPhotos: 3,
    messageMin: 10,
    messageMax: 1000,
    noteMax: 500,
    shortTextMax: 80,
    longTextMax: 1000,
    urlMax: 300,
    emailMax: 254
} as const

export type MarketType = (typeof MARKET.types)[number]
export type MarketCategory = (typeof MARKET.categories)[number]
export type MarketPriceUnit = (typeof MARKET.priceUnits)[number]
export type Reason = (typeof MARKET.reasons)[number]

export type MarketPostInput = {
    type: MarketType
    category: MarketCategory
    title: string
    description: string
    priceEur: number | null
    priceFree: boolean
    priceUnit: MarketPriceUnit | null
    location: string | null
    availableFrom: string | null
    details: Record<string, string | number | string[]>
}

export type FieldSpec = {
    key: string
    kind:
        | 'text'
        | 'longText'
        | 'number'
        | 'date'
        | 'select'
        | 'multi'
        | 'url'
        | 'email'
    required: boolean
    options?: readonly string[]
    min?: number
    max?: number
}

export type PriceRule = {
    units: readonly MarketPriceUnit[]
    required: boolean
    free: boolean
}

const JOB_TYPES = [
    'fullTime',
    'partTime',
    'workingStudent',
    'internship',
    'minijob',
    'temporary'
] as const
const LANGUAGES = ['english', 'german', 'other'] as const
const HOUSING_TYPES = [
    'sharedFlatRoom',
    'privateRoom',
    'studio',
    'apartment'
] as const
const DURATIONS = ['short', 'medium', 'long', 'flexible'] as const

const select = (
    key: string,
    required: boolean,
    options: readonly string[]
): FieldSpec => ({ key, kind: 'select', required, options })
const multi = (
    key: string,
    required: boolean,
    options: readonly string[]
): FieldSpec => ({ key, kind: 'multi', required, options })
const simple = (
    key: string,
    kind: 'text' | 'longText' | 'date' | 'url' | 'email',
    required = false
): FieldSpec => ({ key, kind, required })
const num = (key: string, min: number, max: number): FieldSpec => ({
    key,
    kind: 'number',
    required: false,
    min,
    max
})

export const MARKET_FIELDS: Record<
    MarketCategory,
    Record<MarketType, FieldSpec[]>
> = {
    jobs: {
        offer: [
            simple('employer', 'text', true),
            select('jobType', true, JOB_TYPES),
            select('workMode', true, ['onSite', 'hybrid', 'remote']),
            multi('languages', true, LANGUAGES),
            num('weeklyHours', 1, 60),
            simple('requirements', 'longText'),
            select('applyMethod', true, ['url', 'email']),
            simple('applyUrl', 'url'),
            simple('applyEmail', 'email'),
            simple('applyDeadline', 'date'),
            simple('contactName', 'text'),
            simple('contactRole', 'text'),
            simple('contactEmail', 'email'),
            simple('companyWebsite', 'url')
        ],
        request: [
            select('jobType', true, JOB_TYPES),
            select('workMode', false, [
                'onSite',
                'hybrid',
                'remote',
                'flexible'
            ]),
            multi('languages', true, LANGUAGES),
            simple('skills', 'longText'),
            simple('portfolioUrl', 'url')
        ]
    },
    housing: {
        offer: [
            select('housingType', true, HOUSING_TYPES),
            select('rentalDuration', true, DURATIONS),
            num('deposit', 0, 100000),
            multi('rentIncludes', false, [
                'electricity',
                'heating',
                'internet',
                'utilities'
            ]),
            num('sizeSqm', 1, 1000),
            num('rooms', 1, 20),
            select('furnished', false, ['yes', 'no', 'partly']),
            multi('facilities', false, [
                'washingMachine',
                'kitchen',
                'privateBathroom',
                'balcony',
                'elevator',
                'wifi'
            ])
        ],
        request: [
            select('housingType', true, HOUSING_TYPES),
            select('rentalDuration', false, DURATIONS),
            select('furnished', false, ['preferred', 'notNeeded', 'any']),
            select('occupation', true, [
                'student',
                'professional',
                'intern',
                'other'
            ]),
            multi('languages', false, LANGUAGES)
        ]
    }
}

const rule = (
    units: readonly MarketPriceUnit[],
    required: boolean,
    free: boolean
): PriceRule => ({ units, required, free })

export const MARKET_PRICE: Record<
    MarketCategory,
    Record<MarketType, PriceRule>
> = {
    jobs: {
        offer: rule(['perHour', 'perMonth'], false, false),
        request: rule(['perHour', 'perMonth'], false, false)
    },
    housing: {
        offer: rule(['perMonth'], true, false),
        request: rule(['perMonth'], true, false)
    }
}

// Shared column fields a category needs on top of its details.
const REQUIRES_LOCATION: readonly MarketCategory[] = ['jobs', 'housing']
const REQUIRES_AVAILABLE_FROM: readonly MarketCategory[] = ['housing']

export const canReserve = (category: MarketCategory): boolean =>
    category === 'housing'

const isDate = (d: unknown): d is string => {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false
    const parsed = new Date(`${d}T00:00:00Z`)
    return (
        !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === d
    )
}

const isHttpsUrl = (s: string): boolean => {
    if (s.length > MARKET.urlMax) return false
    try {
        const u = new URL(s)
        return u.protocol === 'https:' && !u.username && !u.password
    } catch {
        return false
    }
}

const isEmail = (s: string): boolean => {
    if (s.length > MARKET.emailMax) return false
    try {
        normaliseAccountEmail(s)
        return true
    } catch {
        return false
    }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const clean = (value: string, keepNewlines: boolean) =>
    Array.from(value)
        .filter((ch) => {
            const c = ch.charCodeAt(0)
            if (c === 10) return keepNewlines
            return c >= 32 && c !== 127
        })
        .join('')
        .trim()

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)

const isNil = (v: unknown) => v === undefined || v === null

const oneOf = <T extends string>(
    list: readonly T[],
    value: unknown
): value is T =>
    typeof value === 'string' && (list as readonly string[]).includes(value)

// One detail value; returns undefined when the field counts as absent.
const detailValue = (
    spec: FieldSpec,
    v: unknown
): string | number | string[] | undefined => {
    const fail = (): never => {
        throw new Error(`InvalidMarketPost:details.${spec.key}`)
    }
    if (isNil(v)) return undefined
    switch (spec.kind) {
        case 'number':
            if (
                typeof v !== 'number' ||
                !Number.isInteger(v) ||
                v < (spec.min ?? 0) ||
                v > (spec.max ?? 0)
            )
                return fail()
            return v
        case 'multi': {
            if (
                !Array.isArray(v) ||
                !v.every((o) => oneOf(spec.options ?? [], o)) ||
                new Set(v).size !== v.length
            )
                return fail()
            return v.length ? (v as string[]) : undefined
        }
        default: {
            if (typeof v !== 'string') return fail()
            const s = clean(v, spec.kind === 'longText')
            if (!s) return undefined
            const ok =
                spec.kind === 'text'
                    ? s.length <= MARKET.shortTextMax
                    : spec.kind === 'longText'
                      ? s.length <= MARKET.longTextMax
                      : spec.kind === 'select'
                        ? oneOf(spec.options ?? [], s)
                        : spec.kind === 'date'
                          ? isDate(s)
                          : spec.kind === 'url'
                            ? isHttpsUrl(s)
                            : isEmail(s)
            return ok ? s : fail()
        }
    }
}

const validateDetails = (
    category: MarketCategory,
    type: MarketType,
    input: unknown
): Record<string, string | number | string[]> => {
    const bad = (key: string): never => {
        throw new Error(`InvalidMarketPost:details.${key}`)
    }
    const raw = isNil(input) ? {} : input
    if (!isRecord(raw)) throw new Error('InvalidMarketPost:details')
    const specs = MARKET_FIELDS[category][type]
    for (const key of Object.keys(raw))
        if (!isNil(raw[key]) && !specs.some((f) => f.key === key)) bad(key)
    const out: Record<string, string | number | string[]> = {}
    for (const spec of specs) {
        const v = detailValue(spec, raw[spec.key])
        if (v === undefined) {
            if (spec.required) bad(spec.key)
            continue
        }
        out[spec.key] = v
    }
    // Exactly one application route, matching the chosen method.
    if (category === 'jobs' && type === 'offer') {
        for (const [method, key] of [
            ['url', 'applyUrl'],
            ['email', 'applyEmail']
        ] as const) {
            if ((out.applyMethod === method) !== key in out) bad(key)
        }
    }
    return out
}

export const validatePostInput = (raw: unknown): MarketPostInput => {
    const bad = (f: string): never => {
        throw new Error(`InvalidMarketPost:${f}`)
    }
    if (!isRecord(raw)) return bad('input')

    const text = (
        f: string,
        min: number,
        max: number,
        multiline: boolean
    ): string => {
        const v = raw[f]
        if (typeof v !== 'string') return bad(f)
        const s = clean(v, multiline)
        return s.length < min || s.length > max ? bad(f) : s
    }

    if (!oneOf(MARKET.types, raw.type)) bad('type')
    if (!oneOf(MARKET.categories, raw.category)) bad('category')
    const title = text('title', MARKET.titleMin, MARKET.titleMax, false)
    const description = text(
        'description',
        MARKET.descriptionMin,
        MARKET.descriptionMax,
        true
    )

    const category = raw.category as MarketCategory
    const type = raw.type as MarketType
    const rule = MARKET_PRICE[category][type]

    if (!isNil(raw.priceFree) && typeof raw.priceFree !== 'boolean')
        bad('priceFree')
    const priceFree = raw.priceFree === true
    if (priceFree && !rule.free) bad('priceFree')

    let priceEur: number | null = null
    if (!isNil(raw.priceEur)) {
        const p = raw.priceEur
        if (
            typeof p !== 'number' ||
            !Number.isInteger(p) ||
            p < 0 ||
            p > MARKET.priceMax
        )
            bad('priceEur')
        priceEur = p as number
    }

    let priceUnit: MarketPriceUnit | null = null
    if (!isNil(raw.priceUnit)) {
        if (!oneOf(MARKET.priceUnits, raw.priceUnit)) bad('priceUnit')
        priceUnit = raw.priceUnit as MarketPriceUnit
    }
    if (priceFree) {
        priceEur = null
        priceUnit = null
    } else if (priceEur === null) {
        if (rule.required) bad('priceEur')
        priceUnit = null
    } else if (priceUnit === null) {
        priceUnit = rule.units[0] as MarketPriceUnit
    } else if (!rule.units.includes(priceUnit)) {
        bad('priceUnit')
    }

    let location: string | null = null
    if (!isNil(raw.location)) {
        if (typeof raw.location !== 'string') bad('location')
        const s = clean(raw.location as string, false)
        if (s.length > MARKET.locationMax) bad('location')
        location = s || null
    }
    if (!location && REQUIRES_LOCATION.includes(category)) bad('location')

    let availableFrom: string | null = null
    if (!isNil(raw.availableFrom)) {
        if (!isDate(raw.availableFrom)) bad('availableFrom')
        availableFrom = raw.availableFrom as string
    }
    if (!availableFrom && REQUIRES_AVAILABLE_FROM.includes(category))
        bad('availableFrom')

    const details = validateDetails(category, type, raw.details)

    return {
        type,
        category,
        title,
        description,
        priceEur,
        priceFree,
        priceUnit,
        location,
        availableFrom,
        details
    }
}

export const validatePhotoIds = (raw: unknown): string[] => {
    if (isNil(raw)) return []
    if (
        !Array.isArray(raw) ||
        raw.length > MARKET.maxPhotos ||
        !raw.every((id) => typeof id === 'string' && UUID.test(id)) ||
        new Set(raw).size !== raw.length
    )
        throw new Error('InvalidMarketPost:photoIds')
    return raw as string[]
}

export const validateContactMessage = (raw: unknown): string => {
    if (typeof raw !== 'string') throw new Error('InvalidMarketMessage')
    const s = clean(raw, true)
    if (s.length < MARKET.messageMin || s.length > MARKET.messageMax)
        throw new Error('InvalidMarketMessage')
    return s
}

export const validateReport = (
    raw: unknown
): { reason: Reason; note: string | null } => {
    if (!isRecord(raw) || !oneOf(MARKET.reasons, raw.reason))
        throw new Error('InvalidMarketReport')
    let note: string | null = null
    if (!isNil(raw.note)) {
        if (typeof raw.note !== 'string') throw new Error('InvalidMarketReport')
        const s = clean(raw.note, true)
        if (s.length > MARKET.noteMax) throw new Error('InvalidMarketReport')
        note = s || null
    }
    return { reason: raw.reason as Reason, note }
}
