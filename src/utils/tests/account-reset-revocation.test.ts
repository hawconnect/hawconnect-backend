import { describe, expect, it } from 'bun:test'
import { revokeAfterReset } from '../../lib/account-auth'

describe('revokeAfterReset', () => {
    const run = async (failures: number) => {
        let calls = 0
        const lines: string[] = []
        await revokeAfterReset(
            async () => {
                calls++
                if (calls <= failures) throw new Error('db down: secret detail')
            },
            (line) => lines.push(line)
        )
        return { calls, lines }
    }

    it('revokes once when it works', async () => {
        expect(await run(0)).toEqual({ calls: 1, lines: [] })
    })

    it('retries once after a failure', async () => {
        expect(await run(1)).toEqual({ calls: 2, lines: [] })
    })

    it('never fails the completed reset; logs a fixed line', async () => {
        expect(await run(2)).toEqual({
            calls: 2,
            lines: ['Provider tokens not revoked after password reset']
        })
    })
})
