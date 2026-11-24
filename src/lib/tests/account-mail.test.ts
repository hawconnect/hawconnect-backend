import { expect, test } from 'bun:test'
import { accountMailContent } from '../account-mail'

test('the confirmation mail shows the code and keeps the link', () => {
    const mail = accountMailContent(
        'verify',
        'https://account.hawconnect.de/confirm?token=abc',
        '907223'
    )

    expect(mail.subject).toContain('907223')
    expect(mail.text).toContain('907223')
    expect(mail.text).toContain(
        'https://account.hawconnect.de/confirm?token=abc'
    )
    expect(mail.text).toContain('1 hour')
})
