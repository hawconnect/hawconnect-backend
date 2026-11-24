import { createAccountAuth } from '@/lib/account-auth'
import {
    createAccountMailer,
    createTransactionalMailer
} from '@/lib/account-mail'
import { accountRuntime } from '@/lib/account-runtime'
import { oidcClientSecret } from '@/lib/oidc-clients'
import { withRenamedSettings } from '@/lib/renamed-settings'
import { marketplaceRuntime } from '@/marketplace/runtime'
import { academicCalendarService } from '@/utils/academic-calendar'
import { hamburgFoodService } from '@/utils/food-refresh'
import { hawEventsService } from '@/utils/haw-events'
import { hawNewsServices } from '@/utils/haw-news'
import { createModerationRepository } from './marketplace'
import { CONSOLE_CLIENT_ID, createConsoleSignIn } from './oidc-sign-in'
import { adminEmail } from './policy'
import { createAdminRepository } from './repository'
import type { AdminDependencies } from './router'
import { combineSourceStatus } from './source-status'

const combinedNewsStatus = async () =>
    combineSourceStatus(
        await Promise.all([hawNewsServices.de.get(), hawNewsServices.en.get()])
    )
export function createAdminRuntime(): AdminDependencies | null {
    // HAWCONNECT_DASH_ORIGIN is still accepted (see renamed-settings).
    const consoleOrigin = withRenamedSettings(
        process.env
    ).HAWCONNECT_CONSOLE_ORIGIN
    if (!accountRuntime || !consoleOrigin) return null
    const origin = new URL(consoleOrigin).origin
    if (process.env.NODE_ENV === 'production' && !origin.startsWith('https://'))
        throw Error('HTTPSRequired')
    const bootstrap = (process.env.HAWCONNECT_ADMIN_EMAILS ?? '')
        .split(',')
        .filter((x) => x.trim())
        .map(adminEmail)
    const consoleClientSecret = oidcClientSecret(CONSOLE_CLIENT_ID, process.env)
    const loginOrigin = process.env.HAWCONNECT_LOGIN_ORIGIN
    return {
        origin,
        // Sign-in through account.hawconnect.de once the dashboard client has its secret.
        oidc:
            consoleClientSecret && loginOrigin
                ? createConsoleSignIn({
                      providerAuth: accountRuntime.auth,
                      loginOrigin,
                      consoleOrigin: origin,
                      clientSecret: consoleClientSecret,
                      accountSecret: process.env.HAWCONNECT_ACCOUNT_SECRET ?? ''
                  })
                : null,
        repository: createAdminRepository(accountRuntime.pool, bootstrap),
        marketplace: marketplaceRuntime
            ? createModerationRepository(marketplaceRuntime.pool, {
                  // Present whenever marketplaceRuntime is non-null (it requires the secret).
                  secret: process.env.HAWCONNECT_MARKETPLACE_BLOCK_SECRET ?? '',
                  send: createTransactionalMailer(process.env)
              })
            : null,
        auth: createAccountAuth({
            pool: accountRuntime.pool,
            passwordLogin: true,
            signInLink: true,
            secret: process.env.HAWCONNECT_ACCOUNT_SECRET ?? '',
            baseURL: process.env.HAWCONNECT_AUTH_ORIGIN ?? '',
            webOrigin: origin,
            send: createAccountMailer(process.env)
        }),
        status: async () => {
            const names = [
                'Speiseplan',
                'Semesterzeiten',
                'HAW Events',
                'HAW News'
            ]
            const services = await Promise.allSettled([
                hamburgFoodService.get(),
                academicCalendarService.get(),
                hawEventsService.get(),
                combinedNewsStatus()
            ])
            return services.map((r, i) => {
                if (r.status === 'rejected')
                    return {
                        name: names[i],
                        available: false,
                        stale: true,
                        updatedAt: null
                    }
                const v = r.value
                return {
                    name: names[i],
                    available: v.available,
                    stale: v.stale,
                    updatedAt: v.updatedAt
                }
            })
        }
    }
}
