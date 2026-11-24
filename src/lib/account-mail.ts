import nodemailer from 'nodemailer'
import type { AccountMail } from './account-auth'

export interface TransactionalMail {
    to: string
    replyTo?: string
    subject: string
    text: string
}
export type TransactionalMailer = (message: TransactionalMail) => Promise<void>

type Env = Record<string, string | undefined>

function createTransport(env: Env) {
    if (!env.HAWCONNECT_SMTP_HOST || !env.HAWCONNECT_MAIL_FROM) return undefined
    const port = Number(env.HAWCONNECT_SMTP_PORT ?? 587)
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('InvalidMailConfiguration')
    if (
        Boolean(env.HAWCONNECT_SMTP_USER) !==
        Boolean(env.HAWCONNECT_SMTP_PASSWORD)
    )
        throw new Error('InvalidMailConfiguration')
    const transport = nodemailer.createTransport({
        host: env.HAWCONNECT_SMTP_HOST,
        port,
        secure: port === 465,
        requireTLS: port !== 465,
        ...(env.HAWCONNECT_SMTP_USER
            ? {
                  auth: {
                      user: env.HAWCONNECT_SMTP_USER,
                      pass: env.HAWCONNECT_SMTP_PASSWORD
                  }
              }
            : {}),
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
        logger: false,
        debug: false
    })
    return transport
}

const checkDelivered = (result: {
    accepted?: unknown[]
    rejected?: unknown[]
}) => {
    if (!result.accepted?.length || result.rejected?.length)
        throw new Error('MailDeliveryFailed')
}

/** No default sender, token console output, or successful development mail stub. */
export function createAccountMailer(
    env: Env = process.env
): ((message: AccountMail) => Promise<void>) | undefined {
    const transport = createTransport(env)
    if (!transport) return undefined
    return async ({ email, url, kind = 'link', code }) => {
        const result = await transport.sendMail({
            from: env.HAWCONNECT_MAIL_FROM,
            to: email,
            ...accountMailContent(kind, url, code)
        })
        checkDelivered(result)
    }
}

const IGNORE =
    'Nicht angefordert? Ignoriere diese E-Mail.\nDid not request this? Ignore this email.'

/** Bilingual (German first) account mails. Never contains passwords. */
export function accountMailContent(
    kind: NonNullable<AccountMail['kind']>,
    url: string,
    code?: string
): { subject: string; text: string } {
    if (kind === 'verify')
        return code
            ? {
                  subject: `HAWConnect · Dein Bestätigungscode / Your confirmation code: ${code}`,
                  text: `Gib diesen Code auf der Anmeldeseite ein, um dein HAWConnect-Konto zu aktivieren / Enter this code on the sign-in page to activate your HAWConnect account:\n\n    ${code}\n\nOder öffne diesen Link / Or open this link:\n${url}\n\nCode und Link sind 1 Stunde gültig.\nThe code and link expire in 1 hour.\n\n${IGNORE}`
              }
            : {
                  subject:
                      'HAWConnect · E-Mail-Adresse bestätigen / Confirm your email address',
                  text: `Bestätige deine E-Mail-Adresse, um dein HAWConnect-Konto zu aktivieren / Confirm your email address to activate your HAWConnect account:\n\n${url}\n\nDieser Link ist 1 Stunde gültig.\nThis link expires in 1 hour.\n\n${IGNORE}`
              }
    if (kind === 'reset')
        return {
            subject: 'HAWConnect · Passwort zurücksetzen / Reset your password',
            text: `Lege ein neues Passwort für dein HAWConnect-Konto fest / Set a new password for your HAWConnect account:\n\n${url}\n\nDieser Link ist 1 Stunde gültig und kann einmal verwendet werden.\nThis link expires in 1 hour and can be used once.\n\n${IGNORE} Dein Passwort bleibt dann unverändert.\nYour password then stays unchanged.`
        }
    if (kind === 'exists')
        return {
            subject:
                'HAWConnect · Du hast bereits ein Konto / You already have an account',
            text: `Jemand hat versucht, mit dieser E-Mail-Adresse ein HAWConnect-Konto zu erstellen. Du hast bereits eines. Melde dich an oder setze dein Passwort zurück:\nSomeone tried to create a HAWConnect account with this email address. You already have one. Sign in or reset your password:\n\n${url}\n\n${IGNORE}`
        }
    return {
        subject: 'HAWConnect · Anmelden / Sign in',
        text: `Melde dich bei HAWConnect an / Sign in to HAWConnect:\n\n${url}\n\nDieser Link ist 10 Minuten gültig und kann einmal verwendet werden.\nThis link expires in 10 minutes and can be used once.\n\n${IGNORE}`
    }
}

/**
 * Marks mail as machine-sent so out-of-office and other auto-replies are suppressed:
 * an auto-reply to a contact mail would otherwise reveal the poster's address to the sender.
 */
const AUTO_REPLY_SUPPRESSION = {
    'Auto-Submitted': 'auto-generated',
    'X-Auto-Response-Suppress': 'All',
    Precedence: 'bulk'
}

/** Generic plain-text mail (marketplace contact and moderation notices); same config rules as sign-in mail. */
export function createTransactionalMailer(
    env: Env = process.env
): TransactionalMailer | undefined {
    const transport = createTransport(env)
    if (!transport) return undefined
    return async ({ to, replyTo, subject, text }) => {
        checkDelivered(
            await transport.sendMail({
                from: env.HAWCONNECT_MAIL_FROM,
                to,
                ...(replyTo ? { replyTo } : {}),
                subject,
                text,
                headers: AUTO_REPLY_SUPPRESSION
            })
        )
    }
}
