import { expect, spyOn, test } from 'bun:test'
import nodemailer from 'nodemailer'
import { createTransactionalMailer } from '../../lib/account-mail'
import { blockEmail, contactEmail, removalEmail } from '../mail'

const germanFirst = (text: string, de: string, en: string) => {
    expect(text).toContain(de)
    expect(text).toContain(en)
    expect(text.indexOf(de)).toBeLessThan(text.indexOf(en))
}

test('contact email is bilingual and carries message and report link', () => {
    const mail = contactEmail({
        postTitle: 'Desk for sale',
        message: 'Is the desk still available?',
        reportUrl: 'https://hawconnect.de/marketplace/report/tok123'
    })
    expect(mail.subject).toContain('Desk for sale')
    germanFirst(mail.subject, 'Antwort', 'Reply')
    expect(mail.text).toContain('Is the desk still available?')
    expect(mail.text).toContain(
        'https://hawconnect.de/marketplace/report/tok123'
    )
    expect(mail.text).toContain('Antworte einfach auf diese E-Mail')
    germanFirst(mail.text, 'Antworte', 'Reply')
    expect(mail.text).not.toContain('@')
})

test('removal and block emails are bilingual, German first', () => {
    const removal = removalEmail({ postTitle: 'Desk', reason: 'Spam' })
    expect(removal.text).toContain('Desk')
    expect(removal.text).toContain('Spam')
    germanFirst(removal.text, 'entfernt', 'removed')
    const block = blockEmail({
        reason: 'Scam',
        until: new Date('2027-01-31T12:00:00Z')
    })
    expect(block.text).toContain('Scam')
    expect(block.text).toContain('31.01.2027')
    germanFirst(block.text, 'gesperrt', 'blocked')
})

test('transactional mailer follows the account mailer config rules', () => {
    expect(createTransactionalMailer({})).toBeUndefined()
    expect(() =>
        createTransactionalMailer({
            HAWCONNECT_SMTP_HOST: 'smtp.example.org',
            HAWCONNECT_MAIL_FROM: 'noreply@example.org',
            HAWCONNECT_SMTP_PORT: '99999'
        })
    ).toThrow('InvalidMailConfiguration')
    expect(() =>
        createTransactionalMailer({
            HAWCONNECT_SMTP_HOST: 'smtp.example.org',
            HAWCONNECT_MAIL_FROM: 'noreply@example.org',
            HAWCONNECT_SMTP_USER: 'u'
        })
    ).toThrow('InvalidMailConfiguration')
    expect(
        typeof createTransactionalMailer({
            HAWCONNECT_SMTP_HOST: 'smtp.example.org',
            HAWCONNECT_MAIL_FROM: 'noreply@example.org'
        })
    ).toBe('function')
})

test('contact email says the address stays hidden unless the poster replies', () => {
    const mail = contactEmail({
        postTitle: 'Desk',
        message: 'Hello there, still available?',
        reportUrl: 'https://hawconnect.de/marketplace/report/tok'
    })
    expect(mail.text).not.toContain('nicht weitergegeben')
    expect(mail.text).not.toContain('has not been shared')
    germanFirst(
        mail.text,
        'Die Person sieht deine Adresse nicht, solange du nicht antwortest.',
        'The sender does not see your address unless you reply.'
    )
})

test('marketplace mails spell the product name HAWConnect like the sign-in mail', () => {
    const mails = [
        contactEmail({
            postTitle: 'Desk',
            message: 'Hi there!',
            reportUrl: 'u'
        }),
        removalEmail({ postTitle: 'Desk', reason: 'Spam' }),
        blockEmail({ reason: 'Scam', until: new Date('2027-01-31T12:00:00Z') })
    ]
    for (const m of mails) {
        expect(`${m.subject}\n${m.text}`).not.toContain('HawConnect')
        expect(m.subject).toContain('HAWConnect')
    }
})

test('transactional mail carries auto-reply suppression headers to the transport', async () => {
    const sent: Record<string, unknown>[] = []
    const factory = spyOn(nodemailer, 'createTransport').mockImplementation(
        (() => ({
            sendMail: async (message: Record<string, unknown>) => {
                sent.push(message)
                return { accepted: ['x'], rejected: [] }
            }
        })) as unknown as typeof nodemailer.createTransport
    )
    try {
        const send = createTransactionalMailer({
            HAWCONNECT_SMTP_HOST: 'smtp.example.org',
            HAWCONNECT_MAIL_FROM: 'noreply@example.org'
        })
        await send?.({
            to: 'poster@haw-hamburg.de',
            replyTo: 'sender@haw-hamburg.de',
            subject: 's',
            text: 't'
        })
    } finally {
        factory.mockRestore()
    }
    expect(sent).toHaveLength(1)
    expect(sent[0].headers).toEqual({
        'Auto-Submitted': 'auto-generated',
        'X-Auto-Response-Suppress': 'All',
        Precedence: 'bulk'
    })
    expect(sent[0].replyTo).toBe('sender@haw-hamburg.de')
})

test('contact email never says what kind of account the sender has', () => {
    const text = contactEmail({
        postTitle: 'Desk',
        message: 'Hello there, still available?',
        reportUrl: 'u'
    }).text
    expect(text).not.toContain('HAW account')
    expect(text).not.toContain('guest account')
    expect(text).not.toContain('HAW-Konto')
    expect(text).not.toContain('Gastkonto')
})
