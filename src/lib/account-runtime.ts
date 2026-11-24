import { Pool } from 'pg'
import { createAccountAuth } from './account-auth'
import { createAccountMailer } from './account-mail'
import { APP_CLIENT_ID } from './oidc-app-client'
import { oidcClientSecret } from './oidc-clients'

export function createAccountRuntime(env: NodeJS.ProcessEnv = process.env) {
    if (
        !env.HAWCONNECT_ACCOUNTS_DATABASE_URL ||
        !env.HAWCONNECT_ACCOUNT_SECRET ||
        !env.HAWCONNECT_AUTH_ORIGIN ||
        !env.HAWCONNECT_WEB_ORIGIN
    )
        return null
    const authOrigin = new URL(env.HAWCONNECT_AUTH_ORIGIN)
    const webOrigin = new URL(env.HAWCONNECT_WEB_ORIGIN)
    // Public accounts are the OpenID Connect provider at this origin; without it only accounts are off.
    if (!env.HAWCONNECT_LOGIN_ORIGIN) {
        console.warn('Accounts disabled: HAWCONNECT_LOGIN_ORIGIN not set')
        return null
    }
    const loginOrigin = new URL(env.HAWCONNECT_LOGIN_ORIGIN)
    // The login site is told apart from the API by its host name (loginHostGate);
    // a shared host name would put the login pages in front of every API route.
    if (loginOrigin.hostname === authOrigin.hostname) {
        console.warn(
            'Accounts disabled: HAWCONNECT_LOGIN_ORIGIN must differ from HAWCONNECT_AUTH_ORIGIN'
        )
        return null
    }
    if (
        env.NODE_ENV === 'production' &&
        (authOrigin.protocol !== 'https:' ||
            webOrigin.protocol !== 'https:' ||
            loginOrigin.protocol !== 'https:')
    )
        throw new Error('HTTPSRequired')
    const pool = new Pool({
        connectionString: env.HAWCONNECT_ACCOUNTS_DATABASE_URL,
        max: 5,
        connectionTimeoutMillis: 10000
    })
    return {
        ...createAccountAuth({
            pool,
            secret: env.HAWCONNECT_ACCOUNT_SECRET,
            baseURL: authOrigin.origin,
            loginOrigin: loginOrigin.origin,
            webOrigin: webOrigin.origin,
            registration: true,
            send: createAccountMailer(env),
            appClientSecret: oidcClientSecret(APP_CLIENT_ID, env) || undefined
        }),
        pool
    }
}
export const accountRuntime = createAccountRuntime()
