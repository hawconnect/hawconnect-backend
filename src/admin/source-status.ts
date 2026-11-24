export type SourceStatus = {
    available: boolean
    stale: boolean
    updatedAt: string | null
}
/** German and English news are separate feeds; the dashboard shows them as one source. */
export function combineSourceStatus(parts: SourceStatus[]): SourceStatus {
    const times = parts.map((p) => p.updatedAt)
    return {
        available: parts.every((p) => p.available),
        stale: parts.some((p) => p.stale),
        // The older feed decides how fresh the source is.
        updatedAt: times.includes(null)
            ? null
            : ((times as string[]).sort()[0] ?? null)
    }
}
