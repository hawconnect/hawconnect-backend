import { normaliseAccountEmail } from '@/utils/account-policy'

export const capabilities = [
    'announcements',
    'events',
    'ops',
    'audit',
    'marketplace',
    'admin'
] as const
export type Capability = (typeof capabilities)[number]
/**
 * Any well-formed address can hold dashboard access, not only @haw-hamburg.de.
 * Access still needs a verified account and an explicit grant (or bootstrap entry).
 */
export function adminEmail(value: string): string {
    try {
        return normaliseAccountEmail(value)
    } catch {
        throw Error('InvalidAdminEmail')
    }
}
export function capabilitiesFor(
    email: string,
    bootstrap: string[],
    delegated: string[]
): Capability[] {
    const address = adminEmail(email)
    return bootstrap.includes(address)
        ? ['admin']
        : capabilities.filter((c) => delegated.includes(c))
}
export function requireCapability(grants: Capability[], required: Capability) {
    if (!grants.includes('admin') && !grants.includes(required))
        throw Error('Forbidden')
}
