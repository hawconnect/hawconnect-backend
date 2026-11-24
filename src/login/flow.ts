import { verifyOAuthQueryParams } from '@better-auth/oauth-provider'
import type { OidcClientConfig } from '@/lib/oidc-clients'

/** Shown when there is no flow, or the flow's client is not in the configuration. */
export const DEFAULT_SERVICE = 'HAWConnect'
const MAX_QUERY = 4096
/**
 * The authorize parameters a restart may take over from an expired query,
 * including the client's re-authentication requests (`prompt`, `max_age`);
 * authorize validates all of them again.
 */
const RESTART_PARAMS = [
    'client_id',
    'redirect_uri',
    'scope',
    'state',
    'code_challenge',
    'code_challenge_method',
    'nonce',
    'prompt',
    'max_age',
    'login_hint',
    'ui_locales'
]

/**
 * The provider's signed authorize query as the login pages carry it:
 * - `valid`: signature and lifetime check out; sign-in continues it.
 * - `expired`: expired or not signed, but its client and return address are
 *   registered, so the flow can restart at the client's authorize URL.
 * - `invalid`: nothing safe to continue or restart.
 */
export type Flow =
    | { kind: 'none' }
    | { kind: 'valid'; query: string; service: string; restart?: string }
    | { kind: 'expired'; query: string; service: string; restart: string }
    | { kind: 'invalid' }

export function createFlows(config: {
    clients: OidcClientConfig[]
    loginOrigin: string
    secret: () => Promise<string>
}) {
    const authorizeURL = new URL(
        '/api/auth/oauth2/authorize',
        config.loginOrigin
    )
    /** Rebuilds the client's authorize request from the unsigned part, only for a registered client and return address. */
    function restartOf(params: URLSearchParams, client?: OidcClientConfig) {
        const redirect = params.get('redirect_uri')
        if (!client || !redirect || !client.redirectUris.includes(redirect))
            return undefined
        const url = new URL(authorizeURL)
        url.searchParams.set('response_type', 'code')
        for (const name of RESTART_PARAMS) {
            const value = params.get(name)
            if (value) url.searchParams.set(name, value)
        }
        return url.toString()
    }

    async function read(raw: string | undefined): Promise<Flow> {
        if (!raw) return { kind: 'none' }
        if (raw.length > MAX_QUERY) return { kind: 'invalid' }
        const params = new URLSearchParams(raw)
        if (!params.has('sig') && !params.has('client_id'))
            return { kind: 'none' }
        const clientId = params.get('client_id')
        const client = config.clients.find(
            (entry) => entry.clientId === clientId
        )
        const restart = restartOf(params, client)
        if (await verifyOAuthQueryParams(raw, await config.secret()))
            return {
                kind: 'valid',
                query: raw,
                service: client?.name ?? DEFAULT_SERVICE,
                restart
            }
        if (client && restart)
            return {
                kind: 'expired',
                query: raw,
                service: client.name,
                restart
            }
        return { kind: 'invalid' }
    }

    return { read }
}
