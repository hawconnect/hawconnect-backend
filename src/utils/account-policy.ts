/**
 * HAWConnect accounts verify mailbox ownership, not university enrolment.
 */
export function normaliseAccountEmail(input: string): string {
    const email = input.trim().toLowerCase()
    const parts = email.split('@')
    const [local, domain] = parts
    if (
        email.length > 254 ||
        parts.length !== 2 ||
        !local ||
        local.length > 64 ||
        !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) ||
        local.startsWith('.') ||
        local.endsWith('.') ||
        local.includes('..') ||
        !domain ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
    )
        throw new Error('InvalidAccountEmail')
    return email
}
