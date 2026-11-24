export interface MailContent {
    subject: string
    text: string
}

const date = (d: Date, locale: string) =>
    d.toLocaleDateString(locale, {
        timeZone: 'Europe/Berlin',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    })

export function contactEmail(input: {
    postTitle: string
    message: string
    reportUrl: string
}): MailContent {
    return {
        subject: `Antwort auf deinen HAWConnect-Beitrag / Reply to your HAWConnect post: ${input.postTitle}`,
        text: [
            `Beitrag / Post: ${input.postTitle}`,
            '',
            input.message,
            '',
            '---',
            'Antworte einfach auf diese E-Mail, um der Person zu schreiben. Die Person sieht deine Adresse nicht, solange du nicht antwortest.',
            'Reply to this email to answer. The sender does not see your address unless you reply.',
            '',
            'Nachricht melden / Report this message:',
            input.reportUrl
        ].join('\n')
    }
}

export function removalEmail(input: {
    postTitle: string
    reason: string
}): MailContent {
    return {
        subject: 'HAWConnect · Beitrag entfernt / Post removed',
        text: [
            `Dein Marktplatz-Beitrag „${input.postTitle}“ wurde von der Moderation entfernt.`,
            `Begründung: ${input.reason}`,
            '',
            `Your marketplace post "${input.postTitle}" was removed by the moderators.`,
            `Reason: ${input.reason}`
        ].join('\n')
    }
}

export function blockEmail(input: {
    reason: string
    until: Date
}): MailContent {
    return {
        subject: 'HAWConnect · Marktplatz gesperrt / Marketplace blocked',
        text: [
            `Dein Konto wurde bis ${date(input.until, 'de-DE')} für das Veröffentlichen und Kontaktieren im Marktplatz gesperrt. Ansehen ist weiterhin möglich.`,
            `Begründung: ${input.reason}`,
            '',
            `Your account has been blocked from posting and contacting in the marketplace until ${date(input.until, 'en-GB')}. You can still browse.`,
            `Reason: ${input.reason}`
        ].join('\n')
    }
}
