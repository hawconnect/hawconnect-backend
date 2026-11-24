import { expect, test } from 'bun:test'
import {
    createPhotoStorage,
    PhotoRemoveError,
    readMarketplaceR2Config
} from '../photo-storage'

const config = {
    accountId: 'a'.repeat(32),
    bucket: 'private-bucket',
    accessKeyId: 'k',
    secretAccessKey: 's'
}
const key = (n: number) =>
    `marketplace/00000000-0000-4000-8000-00000000000${n}.jpg`

const fakeClient = (response: unknown) => {
    const sent: unknown[] = []
    return {
        sent,
        client: {
            send: async (command: unknown) => {
                sent.push(command)
                return response
            }
        }
    }
}

test('remove resolves when DeleteObjects reports no per-key errors', async () => {
    const { client, sent } = fakeClient({ $metadata: {} })
    const storage = createPhotoStorage(config, client)
    await storage.remove([key(1), key(2)])
    expect(sent).toHaveLength(1)
})

test('remove reports keys that DeleteObjects failed despite a 200 response', async () => {
    const { client } = fakeClient({
        Errors: [{ Key: key(2), Code: 'InternalError', Message: 'x' }]
    })
    const storage = createPhotoStorage(config, client)
    const error = await storage.remove([key(1), key(2)]).catch((e) => e)
    expect(error).toBeInstanceOf(PhotoRemoveError)
    expect((error as PhotoRemoveError).failedKeys).toEqual([key(2)])
})

test('remove treats a missing key as deleted', async () => {
    const { client } = fakeClient({
        Errors: [{ Key: key(1), Code: 'NoSuchKey' }]
    })
    await createPhotoStorage(config, client).remove([key(1)])
})

test('an error without a key fails every key of the request', async () => {
    const { client } = fakeClient({ Errors: [{ Code: 'AccessDenied' }] })
    const error = await createPhotoStorage(config, client)
        .remove([key(1), key(2)])
        .catch((e) => e)
    expect((error as PhotoRemoveError).failedKeys).toEqual([key(1), key(2)])
})

test('marketplace R2 config uses its own variable names, never the dashboard bucket names', () => {
    const values = {
        ACCOUNT_ID: 'a'.repeat(32),
        ACCESS_KEY_ID: 'k',
        SECRET_ACCESS_KEY: 's',
        BUCKET: 'my-bucket'
    }
    const prefixed = (prefix: string) =>
        Object.fromEntries(
            Object.entries(values).map(([k, v]) => [`${prefix}${k}`, v])
        )
    expect(readMarketplaceR2Config(prefixed('HAWCONNECT_R2_'))).toBeNull()
    expect(
        readMarketplaceR2Config(prefixed('HAWCONNECT_MARKETPLACE_R2_'))
    ).toEqual({
        accountId: 'a'.repeat(32),
        accessKeyId: 'k',
        secretAccessKey: 's',
        bucket: 'my-bucket'
    })
})
