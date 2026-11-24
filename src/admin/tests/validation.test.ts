import { expect, test } from 'bun:test'
import { validateBlock, validateContent } from '../validation'

const base = {
    title: { de: 'Titel', en: 'Title' },
    description: { de: 'Text', en: 'Text' },
    startDateTime: '2026-11-01T09:00:00Z',
    endDateTime: '2026-11-01T10:00:00Z',
    platform: ['WEB'],
    userKind: ['STUDENT'],
    priority: 0,
    url: null,
    imageUrl: null
}
test('validates bilingual content, schedules, audience and safe URLs', () => {
    expect(validateContent('announcements', base).title.de).toBe('Titel')
    for (const input of [
        { ...base, endDateTime: 'bad' },
        { ...base, endDateTime: '2026-10-01T10:00:00Z' },
        { ...base, url: 'javascript:alert(1)' },
        { ...base, platform: ['EVIL'] },
        { ...base, title: { de: '', en: 'Title' } }
    ])
        expect(() => validateContent('announcements', input)).toThrow(
            'InvalidInput'
        )
    expect(() =>
        validateContent('events', { ...base, organizer: '' })
    ).toThrow()
})

test('block email may be any valid account mailbox, normalised', () => {
    const block = (userEmail: string) =>
        validateBlock({ userEmail, reason: 'Spam posts', days: 7 })
    expect(block(' Student@HAW-Hamburg.DE ').userEmail).toBe(
        'student@haw-hamburg.de'
    )
    expect(block('Guest@Example.org').userEmail).toBe('guest@example.org')
    for (const email of ['@haw-hamburg.de', 'a b@example.org', 'a@localhost'])
        expect(() => block(email)).toThrow('InvalidInput')
})
