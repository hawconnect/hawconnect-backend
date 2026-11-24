import { oauthProvider } from '@better-auth/oauth-provider'
import type { BetterAuthPlugin } from 'better-auth'
import { jwt } from 'better-auth/plugins'

/** Everything a HAWConnect service can learn about a person. */
export const OIDC_SCOPES = ['openid', 'email', 'offline_access'] as const

/**
 * The OpenID Connect provider at the login origin: authorization code with
 * PKCE (S256) only, clients from server configuration only, ID tokens signed
 * with keys kept (encrypted) in `haw_jwks`.
 */
export function oidcPlugins(config: {
    loginOrigin: string
}): BetterAuthPlugin[] {
    const issuer = new URL(config.loginOrigin).origin
    return [
        jwt({
            // Session responses are never turned into JWTs; only the provider signs tokens.
            disableSettingJwtHeader: true,
            jwt: { issuer },
            schema: { jwks: { modelName: 'haw_jwks' } }
        }),
        oauthProvider({
            loginPage: '/sign-in',
            consentPage: '/consent',
            scopes: [...OIDC_SCOPES],
            grantTypes: ['authorization_code', 'refresh_token'],
            allowDynamicClientRegistration: false,
            allowUnauthenticatedClientRegistration: false,
            // Clients exist only through server configuration (see oidc-clients.ts);
            // no signed-in user may create, read, list, update or delete one.
            clientPrivileges: () => false,
            // Return addresses must equal a registered one character for character.
            // The add-on's own matching lets loopback http addresses (localhost,
            // 127.0.0.1, [::1]) use any port (RFC 8252); the spec allows no such slack.
            validateRedirectUri: (redirectUri, registeredUris, defaultResult) =>
                defaultResult && registeredUris.includes(redirectUri),
            codeExpiresIn: 60,
            accessTokenExpiresIn: 900,
            idTokenExpiresIn: 900,
            refreshTokenExpiresIn: 2_592_000,
            refreshTokenReuseInterval: 0,
            advertisedMetadata: {
                claims_supported: [
                    'sub',
                    'iss',
                    'aud',
                    'exp',
                    'iat',
                    'sid',
                    'scope',
                    'azp',
                    'email',
                    'email_verified'
                ]
            },
            schema: {
                oauthClient: { modelName: 'haw_oauth_client' },
                oauthResource: { modelName: 'haw_oauth_resource' },
                oauthClientResource: {
                    modelName: 'haw_oauth_client_resource'
                },
                oauthRefreshToken: { modelName: 'haw_oauth_refresh_token' },
                oauthAccessToken: { modelName: 'haw_oauth_access_token' },
                oauthConsent: { modelName: 'haw_oauth_consent' },
                oauthClientAssertion: {
                    modelName: 'haw_oauth_client_assertion'
                }
            }
        })
    ]
}
