type Env = Record<string, string | undefined>

/**
 * Settings that were renamed when the dashboard became HAWConnect Console.
 * The old names keep working so a deploy never breaks on a server that still
 * uses them; the new name wins when both are set.
 */
export const RENAMED_SETTINGS: [current: string, previous: string][] = [
    ['HAWCONNECT_CONSOLE_ORIGIN', 'HAWCONNECT_DASH_ORIGIN'],
    [
        'HAWCONNECT_OIDC_SECRET_HAWCONNECT_CONSOLE',
        'HAWCONNECT_OIDC_SECRET_HAWCONNECT_DASH'
    ]
]

export function withRenamedSettings(env: Env): Env {
    const out = { ...env }
    for (const [current, previous] of RENAMED_SETTINGS)
        if (!out[current]?.trim() && out[previous]?.trim())
            out[current] = out[previous]
    return out
}
