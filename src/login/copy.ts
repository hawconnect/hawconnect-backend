/**
 * Login site wording, German and English. The account texts are copied from the
 * app (`hawconnect/src/localization/{de,en}/account.json`) so both say the same.
 */
const de = {
    signInTitle: 'Anmelden',
    createAccountTitle: 'Konto erstellen',
    resetTitle: 'Passwort zurücksetzen',
    newPasswordTitle: 'Neues Passwort festlegen',
    checkEmailTitle: 'Sieh in dein Postfach',
    confirmTitle: 'E-Mail-Adresse bestätigen',
    signedInTitle: 'Angemeldet',
    signedOutTitle: 'Abgemeldet',
    signOutTitle: 'Abmelden',
    signOutQuestion: 'Möchtest du dich bei HAWConnect abmelden?',
    signOut: 'Abmelden',
    errorTitle: 'Das hat nicht geklappt',
    name: 'Name',
    nameRequired: 'Gib deinen Namen ein.',
    email: 'E-Mail-Adresse',
    password: 'Passwort',
    newPassword: 'Neues Passwort',
    confirmPassword: 'Passwort bestätigen',
    passwordHint: 'Mindestens {{min}} Zeichen',
    signIn: 'Anmelden',
    noAccount: 'Noch kein Konto?',
    signUp: 'Registrieren',
    createAccount: 'Konto erstellen',
    haveAccount: 'Du hast schon ein Konto?',
    forgotPassword: 'Passwort vergessen?',
    resetSubtitle:
        'Gib deine E-Mail-Adresse ein. Wir senden dir einen Link, mit dem du ein neues Passwort festlegst.',
    sendResetLink: 'Link senden',
    rememberPassword: 'Passwort wieder eingefallen?',
    newPasswordSubtitle:
        'Wähle ein neues Passwort für dein Konto. Andere Geräte werden abgemeldet.',
    setNewPassword: 'Neues Passwort festlegen',
    confirmInstructions:
        'Fahre fort, um deine E-Mail-Adresse zu bestätigen. Melde dich danach mit deinem Passwort an.',
    continue: 'Fortfahren',
    resendConfirmation: 'Neuen Code senden',
    code: 'Bestätigungscode',
    confirmCode: 'Bestätigen',
    backToSignIn: 'Zur Anmeldung zurück',
    invalidCredentials: 'E-Mail-Adresse oder Passwort ist falsch.',
    emailNotVerified:
        'Bestätige zuerst deine E-Mail-Adresse. Gib den 6-stelligen Code aus unserer E-Mail ein.',
    invalidCode:
        'Dieser Code ist falsch oder abgelaufen. Prüfe ihn oder lass dir einen neuen Code senden.',
    codeSent:
        'Wir haben dir einen neuen Code geschickt. Er ist 1 Stunde gültig.',
    checkEmail:
        'Wir haben dir einen 6-stelligen Code geschickt. Gib ihn hier ein, um deine E-Mail-Adresse zu bestätigen. Er ist 1 Stunde gültig.',
    resetSent:
        'Falls es zu dieser E-Mail-Adresse ein Konto gibt, haben wir einen Link zum Festlegen eines neuen Passworts geschickt. Er ist 1 Stunde gültig.',
    emailConfirmed:
        'Deine E-Mail-Adresse ist bestätigt. Melde dich mit deinem Passwort an.',
    passwordChanged:
        'Dein Passwort ist geändert. Melde dich mit dem neuen Passwort an.',
    invalidEmail: 'Gib eine gültige E-Mail-Adresse ein.',
    passwordTooShort: 'Verwende ein Passwort mit mindestens {{min}} Zeichen.',
    passwordTooLong: 'Verwende ein Passwort mit höchstens 128 Zeichen.',
    passwordMismatch: 'Die beiden Passwörter stimmen nicht überein.',
    rateLimit:
        'Zu viele Versuche. Bitte warte eine Weile und versuche es erneut.',
    mailUnavailable:
        'Der E-Mail-Versand ist nicht eingerichtet oder konnte nicht bestätigt werden. Bitte versuche es später erneut.',
    unavailable:
        'Der Kontodienst ist nicht verfügbar. Bitte versuche es später erneut.',
    invalidLink:
        'Dieser Link ist ungültig, abgelaufen oder bereits verwendet. Fordere auf der Anmeldeseite einen neuen an.',
    resetLinkMissing:
        'Öffne den vollständigen Link aus der E-Mail zum Zurücksetzen oder fordere auf der Anmeldeseite einen neuen an.',
    signedIn:
        'Du bist bei HAWConnect angemeldet. Du kannst dieses Fenster schließen.',
    signedOut:
        'Du bist bei HAWConnect abgemeldet. Du kannst dieses Fenster schließen.',
    unknownClient:
        'Diese App ist nicht registriert. Öffne die Anmeldung erneut aus der App, die du verwenden möchtest.',
    flowFailed:
        'Die Anmeldung konnte nicht fortgesetzt werden. Öffne sie erneut aus der App, die du verwenden möchtest.',
    consentUnavailable:
        'Diese App darf nicht auf dein HAWConnect-Konto zugreifen.',
    notFound: 'Diese Seite gibt es nicht.',
    agreeBefore: 'Wenn du fortfährst, stimmst du unseren ',
    terms: 'Nutzungsbedingungen',
    agreeBetween: ' und der ',
    privacy: 'Datenschutzerklärung',
    agreeAfter: ' zu.',
    language: 'Sprache',
    theme: 'Design',
    themeLight: 'Hell',
    themeDark: 'Dunkel',
    themeSystem: 'System'
}

export type Copy = typeof de

const en: Copy = {
    signInTitle: 'Sign in',
    createAccountTitle: 'Create an account',
    resetTitle: 'Reset your password',
    newPasswordTitle: 'Set a new password',
    checkEmailTitle: 'Check your email',
    confirmTitle: 'Confirm your email',
    signedInTitle: 'Signed in',
    signedOutTitle: 'Signed out',
    signOutTitle: 'Sign out',
    signOutQuestion: 'Do you want to sign out of HAWConnect?',
    signOut: 'Sign out',
    errorTitle: 'That did not work',
    name: 'Name',
    nameRequired: 'Enter your name.',
    email: 'Email address',
    password: 'Password',
    newPassword: 'New password',
    confirmPassword: 'Confirm password',
    passwordHint: 'At least {{min}} characters',
    signIn: 'Sign in',
    noAccount: "Don't have an account?",
    signUp: 'Sign up',
    createAccount: 'Create account',
    haveAccount: 'Already have an account?',
    forgotPassword: 'Forgot password?',
    resetSubtitle:
        "Enter your email and we'll send you a link to set a new password.",
    sendResetLink: 'Send reset link',
    rememberPassword: 'Remember your password?',
    newPasswordSubtitle:
        'Choose a new password for your account. Other devices are signed out.',
    setNewPassword: 'Set new password',
    confirmInstructions:
        'Continue to confirm your email address. Afterwards, sign in with your password.',
    continue: 'Continue',
    resendConfirmation: 'Send a new code',
    code: 'Confirmation code',
    confirmCode: 'Confirm',
    backToSignIn: 'Return to sign-in',
    invalidCredentials: 'Wrong email or password.',
    emailNotVerified:
        'Confirm your email address first. Enter the 6-digit code from our email.',
    invalidCode:
        'This code is wrong or has expired. Check it or ask for a new code.',
    codeSent: 'We sent you a new code. It expires in 1 hour.',
    checkEmail:
        'We sent you a 6-digit code. Enter it here to confirm your email address. It expires in 1 hour.',
    resetSent:
        'If this email address has an account, we sent a link to set a new password. It expires in 1 hour.',
    emailConfirmed:
        'Your email address is confirmed. Sign in with your password.',
    passwordChanged: 'Your password is changed. Sign in with the new password.',
    invalidEmail: 'Enter a valid email address.',
    passwordTooShort: 'Use a password with at least {{min}} characters.',
    passwordTooLong: 'Use a password with at most 128 characters.',
    passwordMismatch: 'The two passwords do not match.',
    rateLimit: 'Too many attempts. Please wait a while and try again.',
    mailUnavailable:
        'Email delivery is not configured or could not be confirmed. Please try again later.',
    unavailable: 'The account service is unavailable. Please try again later.',
    invalidLink:
        'This link is invalid, expired or already used. Request a new one from the sign-in screen.',
    resetLinkMissing:
        'Open the complete link from your password-reset email, or request a new one from the sign-in screen.',
    signedIn: 'You are signed in to HAWConnect. You can close this window.',
    signedOut: 'You are signed out of HAWConnect. You can close this window.',
    unknownClient:
        'This app is not registered. Start signing in again from the app you want to use.',
    flowFailed:
        'Signing in could not continue. Start again from the app you want to use.',
    consentUnavailable: 'This app may not access your HAWConnect account.',
    notFound: 'This page does not exist.',
    agreeBefore: 'By continuing, you agree to our ',
    terms: 'Terms of Service',
    agreeBetween: ' and ',
    privacy: 'Privacy Policy',
    agreeAfter: '.',
    language: 'Language',
    theme: 'Theme',
    themeLight: 'Light',
    themeDark: 'Dark',
    themeSystem: 'System'
}

export type Language = 'de' | 'en'
export const copies: Record<Language, Copy> = { de, en }

/** German when the first of the browser's languages we offer is German, otherwise English. */
export function languageOf(header: string | undefined): Language {
    const ranked = (header ?? '')
        .split(',')
        .map((part, index) => {
            const [tag, ...parameters] = part.trim().split(';')
            const q = parameters
                .map((parameter) => parameter.trim())
                .find((parameter) => parameter.startsWith('q='))
            const quality = q ? Number(q.slice(2)) : 1
            return {
                language: tag.trim().toLowerCase().split('-')[0],
                quality: Number.isFinite(quality) ? quality : 0,
                index
            }
        })
        .filter((entry) => entry.quality > 0)
        .sort((a, b) => b.quality - a.quality || a.index - b.index)
    const first = ranked.find(
        (entry) => entry.language === 'de' || entry.language === 'en'
    )
    return first?.language === 'de' ? 'de' : 'en'
}

/** The cookie that holds the language chosen with the switcher. */
export const LANGUAGE_COOKIE = 'hawconnect-login-lang'

/** The chosen language (cookie `de` or `en`) wins; otherwise the browser's. */
export function resolveLanguage(
    cookieHeader: string | undefined,
    acceptLanguage: string | undefined
): Language {
    for (const part of (cookieHeader ?? '').split(';')) {
        const index = part.indexOf('=')
        if (index > 0 && part.slice(0, index).trim() === LANGUAGE_COOKIE) {
            const value = part.slice(index + 1).trim()
            if (value === 'de' || value === 'en') return value
        }
    }
    return languageOf(acceptLanguage)
}

/** The cookie that holds the theme chosen with the toggle (`light` or `dark`; absent means the device's). */
export const THEME_COOKIE = 'hawconnect-login-theme'
export type Theme = 'light' | 'dark'

export function themeOf(cookieHeader: string | undefined): Theme | undefined {
    for (const part of (cookieHeader ?? '').split(';')) {
        const index = part.indexOf('=')
        if (index > 0 && part.slice(0, index).trim() === THEME_COOKIE) {
            const value = part.slice(index + 1).trim()
            if (value === 'light' || value === 'dark') return value
        }
    }
    return undefined
}

/** Fills `{{name}}` placeholders; the result is still escaped when rendered. */
export const fill = (text: string, values: Record<string, string | number>) =>
    text.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
        key in values ? String(values[key]) : match
    )
