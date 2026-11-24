import { normaliseAccountEmail } from '@/utils/account-policy'
export type ContentKind = 'announcements' | 'events'
export interface ContentInput {
    title: { de: string; en: string }
    description: { de: string; en: string }
    startDateTime: string
    endDateTime: string | null
    platform: string[]
    userKind: string[]
    priority: number
    url: string | null
    imageUrl: string | null
    organizer: string
    location: string | null
}
function text(value: unknown, max: number, required = false): string {
    if (
        typeof value !== 'string' ||
        value.length > max ||
        (required && !value.trim())
    )
        throw Error('InvalidInput')
    return value.trim()
}
function link(value: unknown): string | null {
    if (value == null || value === '') return null
    const raw = text(value, 2048)
    try {
        const u = new URL(raw)
        if (u.protocol !== 'https:' || u.username || u.password) throw Error()
        return u.toString()
    } catch {
        throw Error('InvalidInput')
    }
}
export function validateContent(
    kind: ContentKind,
    value: unknown
): ContentInput {
    const v = value as Record<string, unknown>
    if (!v || typeof v !== 'object' || Array.isArray(v))
        throw Error('InvalidInput')
    const bilingual = (field: unknown, required: boolean, max: number) => {
        const b = field as Record<string, unknown>
        if (!b || typeof b !== 'object') throw Error('InvalidInput')
        return {
            de: text(b.de ?? '', max, required),
            en: text(b.en ?? '', max, required)
        }
    }
    const date = (d: unknown) => {
        const s = text(d, 64, true)
        if (
            !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(s) ||
            !Number.isFinite(Date.parse(s))
        )
            throw Error('InvalidInput')
        return new Date(s).toISOString()
    }
    const start = date(v.startDateTime)
    const end = v.endDateTime ? date(v.endDateTime) : null
    if ((kind === 'announcements' && !end) || (end && end < start))
        throw Error('InvalidInput')
    const allowed = (a: unknown, list: string[]) => {
        if (
            !Array.isArray(a) ||
            !a.length ||
            a.length > list.length ||
            a.some((x) => !list.includes(x))
        )
            throw Error('InvalidInput')
        return [...new Set(a)] as string[]
    }
    const priority = v.priority ?? 0
    if (
        !Number.isInteger(priority) ||
        Number(priority) < 0 ||
        Number(priority) > 100
    )
        throw Error('InvalidInput')
    return {
        title: bilingual(v.title, true, 250),
        description: bilingual(v.description, kind === 'announcements', 20000),
        startDateTime: start,
        endDateTime: end,
        platform:
            kind === 'announcements'
                ? allowed(v.platform, ['ANDROID', 'IOS', 'WEB'])
                : [],
        userKind:
            kind === 'announcements'
                ? allowed(v.userKind, ['STUDENT', 'EMPLOYEE', 'GUEST'])
                : [],
        priority: Number(priority),
        url: kind === 'events' ? link(text(v.url, 2048, true)) : link(v.url),
        imageUrl: link(v.imageUrl),
        organizer: kind === 'events' ? text(v.organizer, 250, true) : '',
        location: v.location ? text(v.location, 500) : null
    }
}

const MARKET_ID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function marketId(value: unknown): string {
    if (typeof value !== 'string' || !MARKET_ID.test(value))
        throw Error('InvalidInput')
    return value.toLowerCase()
}
function modReason(value: unknown): string {
    const reason = text(value, 500, true)
    if (reason.length < 3) throw Error('InvalidInput')
    return reason
}
export function validateDecision(body: unknown): {
    action: 'dismiss' | 'remove'
    reason: string | null
} {
    const v = (body ?? {}) as Record<string, unknown>
    if (v.action === 'dismiss') return { action: 'dismiss', reason: null }
    if (v.action === 'remove')
        return { action: 'remove', reason: modReason(v.reason) }
    throw Error('InvalidInput')
}
export function validatePostRemoval(body: unknown): string {
    return modReason(((body ?? {}) as Record<string, unknown>).reason)
}
/** `view` and search text for the moderator post list. */
export function validatePostFilter(query: Record<string, unknown>): {
    view: 'live' | 'hidden' | 'all'
    q: string | null
} {
    const view = query.view ?? 'all'
    if (view !== 'live' && view !== 'hidden' && view !== 'all')
        throw Error('InvalidInput')
    const q = query.q === undefined ? '' : text(query.q, 100, false)
    return { view, q: q.trim() || null }
}
export function validateBlock(body: unknown): {
    userEmail: string
    reason: string
    days: number
} {
    const v = (body ?? {}) as Record<string, unknown>
    let userEmail: string
    try {
        userEmail = normaliseAccountEmail(text(v.userEmail, 254, true))
    } catch {
        throw Error('InvalidInput')
    }
    if (!Number.isInteger(v.days) || Number(v.days) < 1 || Number(v.days) > 365)
        throw Error('InvalidInput')
    return { userEmail, reason: modReason(v.reason), days: Number(v.days) }
}
