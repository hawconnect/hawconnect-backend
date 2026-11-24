import { readFile } from 'node:fs/promises'
import { accountRuntime } from '@/lib/account-runtime'

if (!accountRuntime) throw Error('AccountConfigurationRequired')
const client = await accountRuntime.pool.connect()
try {
    await client.query('BEGIN')
    await client.query(
        await readFile(new URL('./marketplace.sql', import.meta.url), 'utf8')
    )
    await client.query('COMMIT')
    console.info('Marketplace migration complete; existing data preserved')
} catch (error) {
    await client.query('ROLLBACK')
    throw error
} finally {
    client.release()
    await accountRuntime.pool.end()
}
