import { accountRuntime } from '@/lib/account-runtime'
import { createTransactionalMailer } from '../lib/account-mail'
import {
    createLocalPhotoStorage,
    type LocalPhotoStorage,
    localPhotoDir
} from './local-photo-storage'
import { createPhotoStorage, readMarketplaceR2Config } from './photo-storage'
import { createMarketplaceResolvers } from './resolvers'
import { createMarketplace } from './service'

function build(env: NodeJS.ProcessEnv = process.env) {
    const secret = env.HAWCONNECT_MARKETPLACE_BLOCK_SECRET
    const r2 = readMarketplaceR2Config(env)
    // Development only: a local folder stands in for the bucket when R2 is not configured.
    const localDir = r2 ? null : localPhotoDir(env)
    if (
        !accountRuntime ||
        !secret ||
        secret.length < 32 ||
        (!r2 && !(localDir && env.HAWCONNECT_AUTH_ORIGIN))
    )
        return null
    try {
        const localPhotos: LocalPhotoStorage | null = r2
            ? null
            : createLocalPhotoStorage({
                  dir: localDir as string,
                  baseURL: env.HAWCONNECT_AUTH_ORIGIN as string,
                  secret
              })
        const storage = r2 ? createPhotoStorage(r2) : localPhotos
        if (!storage) return null
        return {
            storage,
            localPhotos,
            pool: accountRuntime.pool,
            service: createMarketplace({
                pool: accountRuntime.pool,
                storage,
                send: createTransactionalMailer(env),
                now: () => new Date(),
                blockSecret: secret,
                webOrigin: new URL(env.HAWCONNECT_WEB_ORIGIN as string).origin
            })
        }
    } catch {
        return null
    }
}

/**
 * Null when accounts, the block secret or the private marketplace bucket (HAWCONNECT_MARKETPLACE_R2_*,
 * never the dashboard's public HAWCONNECT_R2_* bucket) are not configured; the marketplace is then
 * disabled, never crashing startup.
 */
export const marketplaceRuntime = build()
if (!marketplaceRuntime) console.log('Marketplace disabled: not configured')
else if (marketplaceRuntime.localPhotos)
    console.log(
        'Marketplace: DEVELOPMENT local photo storage (not for production)'
    )

export const marketplaceResolvers = createMarketplaceResolvers(
    marketplaceRuntime?.service ?? null
)
