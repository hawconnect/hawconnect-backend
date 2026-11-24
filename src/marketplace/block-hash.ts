import { createHmac } from 'node:crypto'

export const normaliseEmail = (email: string) => email.trim().toLowerCase()

/** Keyed hash of a normalised email, so blocks survive account deletion without storing the address. */
export function blockHash(email: string, secret: string): string {
    if (!secret) throw new Error('BlockSecretRequired')
    return createHmac('sha256', secret)
        .update(normaliseEmail(email))
        .digest('hex')
}
