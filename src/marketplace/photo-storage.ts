import { randomUUID } from 'node:crypto'
import {
    DeleteObjectsCommand,
    type DeleteObjectsCommandOutput,
    GetObjectCommand,
    PutObjectCommand,
    S3Client
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export interface MarketplaceR2Config {
    accountId: string
    bucket: string
    accessKeyId: string
    secretAccessKey: string
}

export interface PhotoStorage {
    put(key: string, data: Buffer, contentType: string): Promise<void>
    signedUrl(key: string, seconds?: number): Promise<string>
    /**
     * Resolves only when every key is confirmed gone (a missing key counts as gone).
     * Throws PhotoRemoveError naming the keys that failed; any other error means none are confirmed.
     */
    remove(keys: string[]): Promise<void>
}

/** Some keys of a remove() call were not deleted; the others were. */
export class PhotoRemoveError extends Error {
    constructor(readonly failedKeys: string[]) {
        super('PhotoRemoveFailed')
        this.name = 'PhotoRemoveError'
    }
}

/** Keys of a remove() call that storage did not confirm as deleted. */
export function unconfirmedKeys(keys: string[], error: unknown): string[] {
    return error instanceof PhotoRemoveError
        ? keys.filter((k) => error.failedKeys.includes(k))
        : keys
}

/** Sends put/delete commands; tests inject a fake. Signing always uses the real client. */
export interface S3Sender {
    send(command: PutObjectCommand | DeleteObjectsCommand): Promise<unknown>
}

export function readMarketplaceR2Config(
    env: Record<string, string | undefined> = process.env
): MarketplaceR2Config | null {
    // Deliberately not the dashboard's HAWCONNECT_R2_* names: this must be a private bucket.
    const get = (n: string) =>
        env[`HAWCONNECT_MARKETPLACE_R2_${n}`]?.trim() ?? ''
    const config = {
        accountId: get('ACCOUNT_ID'),
        bucket: get('BUCKET'),
        accessKeyId: get('ACCESS_KEY_ID'),
        secretAccessKey: get('SECRET_ACCESS_KEY')
    }
    if (
        !/^[a-f0-9]{32}$/i.test(config.accountId) ||
        !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket) ||
        !config.accessKeyId ||
        !config.secretAccessKey
    )
        return null
    return config
}

export function newPhotoKey(contentType: 'image/jpeg' | 'image/webp') {
    return `marketplace/${randomUUID()}.${contentType === 'image/jpeg' ? 'jpg' : 'webp'}`
}

export function createPhotoStorage(
    config: MarketplaceR2Config,
    sender?: S3Sender
): PhotoStorage {
    const client = new S3Client({
        region: 'auto',
        endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey
        }
    })
    const send = (command: PutObjectCommand | DeleteObjectsCommand) =>
        sender ? sender.send(command) : client.send(command as never)
    const guard = (key: string) => {
        if (!/^marketplace\/[0-9a-f-]{36}\.(jpg|webp)$/.test(key))
            throw Error('InvalidKey')
    }
    return {
        async put(key, data, contentType) {
            guard(key)
            await send(
                new PutObjectCommand({
                    Bucket: config.bucket,
                    Key: key,
                    Body: data,
                    ContentType: contentType,
                    CacheControl: 'private, no-store'
                })
            )
        },
        async signedUrl(key, seconds = 3600) {
            guard(key)
            return getSignedUrl(
                client,
                new GetObjectCommand({
                    Bucket: config.bucket,
                    Key: key,
                    ResponseCacheControl: 'private, no-store'
                }),
                { expiresIn: seconds }
            )
        },
        async remove(keys) {
            if (!keys.length) return
            for (const k of keys) guard(k)
            // DeleteObjects answers 200 even when single keys fail; those are listed in Errors.
            const result = (await send(
                new DeleteObjectsCommand({
                    Bucket: config.bucket,
                    Delete: {
                        Objects: keys.map((Key) => ({ Key })),
                        Quiet: true
                    }
                })
            )) as DeleteObjectsCommandOutput | undefined
            const errors = (result?.Errors ?? []).filter(
                (e) => e.Code !== 'NoSuchKey'
            )
            if (!errors.length) return
            const named = keys.filter((k) => errors.some((e) => e.Key === k))
            // An error we cannot tie to a requested key leaves every key unconfirmed.
            throw new PhotoRemoveError(
                errors.every((e) => e.Key && keys.includes(e.Key))
                    ? named
                    : keys
            )
        }
    }
}
