import { expect, test } from 'bun:test'
import { adminEmail, capabilitiesFor, requireCapability } from '../policy'

test('any valid address can hold admin access, but only with an explicit grant', () => {
    expect(adminEmail(' Maintainer@haw-hamburg.de ')).toBe(
        'maintainer@haw-hamburg.de'
    )
    expect(adminEmail('Info@EduNavi.de')).toBe('info@edunavi.de')
    expect(adminEmail('someone@gmail.com')).toBe('someone@gmail.com')
    for (const email of [
        '',
        'no-at-sign',
        'two@@example.org',
        'user@localhost',
        '.dot@example.org',
        `${'a'.repeat(65)}@example.org`
    ])
        expect(() => adminEmail(email)).toThrow('InvalidAdminEmail')
    expect(capabilitiesFor('someone@gmail.com', [], [])).toEqual([])
    expect(
        capabilitiesFor('someone@gmail.com', ['someone@gmail.com'], [])
    ).toEqual(['admin'])
    expect(capabilitiesFor('mod@example.org', [], ['marketplace'])).toEqual([
        'marketplace'
    ])
    expect(capabilitiesFor('student@haw-hamburg.de', [], [])).toEqual([])
    expect(
        capabilitiesFor('admin@haw-hamburg.de', ['admin@haw-hamburg.de'], [])
    ).toEqual(['admin'])
    expect(() => requireCapability(['announcements'], 'admin')).toThrow(
        'Forbidden'
    )
    expect(() => requireCapability(['admin'], 'events')).not.toThrow()
})

test('marketplace is a delegable capability, implied by admin', () => {
    expect(capabilitiesFor('m@haw-hamburg.de', [], ['marketplace'])).toEqual([
        'marketplace'
    ])
    expect(() => requireCapability(['events'], 'marketplace')).toThrow(
        'Forbidden'
    )
    expect(() => requireCapability(['admin'], 'marketplace')).not.toThrow()
})
