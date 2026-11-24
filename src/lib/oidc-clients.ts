import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { AccountAuthService } from './account-auth'
import { OIDC_SCOPES } from './oidc-provider'
import { withRenamedSettings } from './renamed-settings'

export type OidcClientConfig = {
    clientId: string
    name: string
    type: 'confidential' | 'public'
    redirectUris: string[]
    postLogoutRedirectUris: string[]
    scopes: string[]
    firstParty: boolean
}

type Env = Record<string, string | undefined>

const PLACEHOLDERS = [
    'HAWCONNECT_AUTH_ORIGIN',
    'HAWCONNECT_WEB_ORIGIN',
    'HAWCONNECT_CONSOLE_ORIGIN'
]
const APP_REDIRECT = 'hawconnect://auth/callback'
const MIN_SECRET_LENGTH = 32
const invalid = (reason: string) => new Error(`InvalidOidcClients:${reason}`)

/** `hawconnect-app` becomes `HAWCONNECT_OIDC_SECRET_HAWCONNECT_APP`. */
export const oidcSecretVariable = (clientId: string) =>
    `HAWCONNECT_OIDC_SECRET_${clientId.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`

/** An origin placeholder as an origin (`http://localhost:4000/` → `http://localhost:4000`), as the app client builds its addresses. */
const originOf = (name: string, env: Env) => {
    const value = PLACEHOLDERS.includes(name) ? env[name] : undefined
    if (!value) throw invalid(`placeholder:${name}`)
    try {
        const { origin } = new URL(value)
        if (origin === 'null') throw invalid(`placeholder:${name}`)
        return origin
    } catch {
        throw invalid(`placeholder:${name}`)
    }
}
const expand = (value: string, env: Env) =>
    value.replace(/\$\{([^}]*)\}/g, (_match, name: string) =>
        originOf(name, env)
    )

/** The client secret from the environment, without surrounding whitespace. */
export const oidcClientSecret = (clientId: string, env: Env) =>
    (withRenamedSettings(env)[oidcSecretVariable(clientId)] ?? '').trim()

/**
 * Why loading or syncing the clients failed, for the startup log: names the
 * variable or the file, never a value or the underlying message.
 */
export function oidcClientsProblem(error: unknown): string {
    const message = error instanceof Error ? error.message : ''
    if (message.startsWith('InvalidOidcClients:')) {
        const [kind, subject] = message
            .slice('InvalidOidcClients:'.length)
            .split(':')
        if (kind === 'secret' && subject)
            return `${oidcSecretVariable(subject)} missing or shorter than ${MIN_SECRET_LENGTH} characters`
        if (kind === 'placeholder' && subject)
            return `${PLACEHOLDERS.includes(subject) ? subject : 'unknown placeholder'} missing or not a URL`
        return `config/oidc-clients.json: invalid ${kind}${subject ? ` (${subject})` : ''}`
    }
    if (error instanceof SyntaxError)
        return 'config/oidc-clients.json is not valid JSON'
    if ((error as { code?: unknown } | null)?.code === 'ENOENT')
        return 'config/oidc-clients.json missing'
    return 'database not ready or unreachable'
}

/** https, plain http only for localhost, and exactly the app's own scheme. */
function allowedRedirect(uri: string) {
    if (/[*\s]/.test(uri) || uri.includes('#')) return false
    let url: URL
    try {
        url = new URL(uri)
    } catch {
        return false
    }
    if (url.username || url.password) return false
    if (url.protocol === 'https:') return true
    if (url.protocol === 'http:')
        return (
            url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
        )
    return uri === APP_REDIRECT
}

const strings = (value: unknown, clientId: string, field: string) => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
        throw invalid(`${field}:${clientId}`)
    return value as string[]
}

export function parseOidcClients(
    json: unknown,
    rawEnv: Env
): OidcClientConfig[] {
    const env = withRenamedSettings(rawEnv)
    const entries = Array.isArray(json)
        ? json
        : (json as { clients?: unknown } | null)?.clients
    if (!Array.isArray(entries)) throw invalid('shape')
    const seen = new Set<string>()
    return entries.flatMap((entry: Record<string, unknown>) => {
        const clientId = entry?.clientId
        if (
            typeof clientId !== 'string' ||
            !/^[a-z][a-z0-9-]{1,62}$/.test(clientId)
        )
            throw invalid('clientId')
        if (seen.has(clientId)) throw invalid(`duplicate:${clientId}`)
        seen.add(clientId)
        if (
            typeof entry.name !== 'string' ||
            !entry.name.trim() ||
            (entry.type !== 'confidential' && entry.type !== 'public') ||
            typeof entry.firstParty !== 'boolean' ||
            (entry.requires !== undefined &&
                !PLACEHOLDERS.includes(entry.requires as string))
        )
            throw invalid(`shape:${clientId}`)
        // A client for an optional deployment (the dashboard) only exists where
        // that deployment and its secret are configured, so a missing secret
        // turns off that client alone and never the app's sign-in.
        if (
            typeof entry.requires === 'string' &&
            (!env[entry.requires] ||
                oidcClientSecret(clientId, env).length < MIN_SECRET_LENGTH)
        )
            return []
        const scopes = strings(entry.scopes, clientId, 'scope')
        if (
            !scopes.length ||
            scopes.some(
                (scope) => !(OIDC_SCOPES as readonly string[]).includes(scope)
            )
        )
            throw invalid(`scope:${clientId}`)
        const uris = (field: string) =>
            strings(entry[field] ?? [], clientId, 'redirect').map((uri) => {
                const expanded = expand(uri, env)
                if (!allowedRedirect(expanded))
                    throw invalid(`redirect:${clientId}`)
                return expanded
            })
        const redirectUris = uris('redirectUris')
        if (!redirectUris.length) throw invalid(`redirect:${clientId}`)
        const postLogoutRedirectUris = uris('postLogoutRedirectUris')
        if (
            entry.type === 'confidential' &&
            oidcClientSecret(clientId, env).length < MIN_SECRET_LENGTH
        )
            throw invalid(`secret:${clientId}`)
        return [
            {
                clientId,
                name: entry.name,
                type: entry.type,
                redirectUris,
                postLogoutRedirectUris,
                scopes,
                firstParty: entry.firstParty
            }
        ]
    })
}

/** The add-on's own storage format for client secrets (SHA-256, base64url). */
const hashSecret = (secret: string) =>
    createHash('sha256').update(secret).digest('base64url')

/**
 * Writes the configured clients through better-auth's adapter. The add-on's
 * client endpoints always tie a client to a signed-in user (who could delete it),
 * so owner-less clients are stored directly: no `userId`, no `referenceId`.
 * Clients missing from the configuration are disabled, never deleted.
 */
export async function syncOidcClients(
    auth: AccountAuthService['auth'],
    clients: OidcClientConfig[],
    env: Env = process.env
) {
    const { adapter } = await auth.$context
    const model = 'oauthClient'
    const now = new Date()
    const secrets = new Map(
        clients.map((client) => {
            if (client.type === 'public') return [client.clientId, null]
            const secret = oidcClientSecret(client.clientId, env)
            if (secret.length < MIN_SECRET_LENGTH)
                throw invalid(`secret:${client.clientId}`)
            return [client.clientId, hashSecret(secret)]
        })
    )
    const wanted = new Set(clients.map((client) => client.clientId))
    for (const client of clients) {
        const data = {
            name: client.name,
            clientSecret: secrets.get(client.clientId) ?? null,
            disabled: false,
            scopes: client.scopes,
            redirectUris: client.redirectUris,
            postLogoutRedirectUris: client.postLogoutRedirectUris,
            tokenEndpointAuthMethod:
                client.type === 'public' ? 'none' : 'client_secret_post',
            grantTypes: ['authorization_code', 'refresh_token'],
            responseTypes: ['code'],
            applicationType: client.redirectUris.some((uri) =>
                uri.startsWith('hawconnect:')
            )
                ? 'native'
                : 'web',
            skipConsent: client.firstParty,
            enableEndSession: true,
            requirePKCE: true,
            userId: null,
            referenceId: null,
            updatedAt: now
        }
        const where = [{ field: 'clientId', value: client.clientId }]
        if (await adapter.findOne({ model, where }))
            await adapter.update({ model, where, update: data })
        else
            await adapter.create({
                model,
                data: { ...data, clientId: client.clientId, createdAt: now }
            })
    }
    const existing = await adapter.findMany<{
        clientId: string
        disabled?: boolean | null
    }>({ model })
    for (const row of existing)
        if (!wanted.has(row.clientId) && !row.disabled)
            await adapter.update({
                model,
                where: [{ field: 'clientId', value: row.clientId }],
                update: { disabled: true, updatedAt: now }
            })
}

/** Reads and validates `config/oidc-clients.json` against `env`. */
export async function loadConfiguredOidcClients(env: Env = process.env) {
    const file = await readFile(
        new URL('../../config/oidc-clients.json', import.meta.url),
        'utf8'
    )
    return parseOidcClients(JSON.parse(file), env)
}

/** Reads `config/oidc-clients.json`, validates it against `env` and syncs it. */
export async function syncConfiguredOidcClients(
    auth: AccountAuthService['auth'],
    env: Env = process.env
) {
    await syncOidcClients(auth, await loadConfiguredOidcClients(env), env)
}
