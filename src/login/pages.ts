import { MAX_PASSWORD, MIN_PASSWORD } from '@/lib/account-actions'
import { type Copy, fill, type Language, type Theme } from './copy'

/** Markup that is already safe: produced by `html` itself, never from input. */
export class Html {
    constructor(readonly value: string) {}
    toString() {
        return this.value
    }
}

const ENTITIES: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
}
/** The one escaping helper: every interpolated value goes through it. */
export const escapeHtml = (value: unknown) =>
    String(value).replace(/[&<>"']/g, (char) => ENTITIES[char])

const render = (value: unknown): string => {
    if (value instanceof Html) return value.value
    if (Array.isArray(value)) return value.map(render).join('')
    if (value === null || value === undefined || value === false) return ''
    return escapeHtml(value)
}

/** Template tag: interpolations are escaped unless they are `Html` fragments. */
export function html(strings: TemplateStringsArray, ...values: unknown[]) {
    let out = strings[0]
    for (let index = 0; index < values.length; index++)
        out += render(values[index]) + strings[index + 1]
    return new Html(out)
}

export interface PageContext {
    lang: Language
    copy: Copy
    /** Name of the service being signed in to (the client's configured name). */
    service: string
    /** The provider's signed authorize query, or '' outside a flow. */
    flow: string
    /** `/login.css?v=…` */
    stylesheet: string
    /** Path and query of the page being shown; the language switcher returns here. */
    current?: string
    /** The theme chosen with the toggle; absent follows the device. */
    theme?: Theme
}
export type Message = { kind: 'error' | 'notice'; text: string } | undefined

/** Longest name accepted when creating an account. */
export const MAX_NAME = 100

/** Legal pages (maintained on hawconnect.de) linked from the sign-in footer. */
const legalURL = (lang: Language, page: 'terms' | 'privacy') =>
    `https://hawconnect.de/${lang}/legal/${page}`

// The HAWConnect mark (hawconnect/src/assets/hawconnect/mark.json), drawn in the primary colour.
const logo = html`<svg class="logo" viewBox="0 0 100 100" width="40" height="40" role="img" aria-label="HAWConnect"><path d="M10 37V20a10 10 0 0 1 20 0v8c-8 1-15 4-20 9Z" fill="currentColor"/><path d="M20 80V58c0-17 15-20 30-12s30 9 30-13V20" fill="none" stroke="currentColor" stroke-width="20" stroke-linecap="round"/><path d="M70 68c8-2 15-6 20-12v24a10 10 0 0 1-20 0Z" fill="currentColor"/></svg>`

const LANGUAGES: { code: Language; label: string }[] = [
    { code: 'de', label: 'Deutsch' },
    { code: 'en', label: 'English' }
]
// Tabler icons (outline, stroke 1.75), drawn inline: no request, no script.
const icon = (paths: string) =>
    new Html(
        `<svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`
    )
const languageIcon = icon(
    '<path d="M4 5h7"/><path d="M9 3v2c0 4.418 -2.239 8 -5 8"/><path d="M5 9c0 2.144 2.952 3.908 6.7 4"/><path d="M12 20l4 -9l4 9"/><path d="M19.1 18h-6.2"/>'
)
const sunIcon = icon(
    '<path d="M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7"/>'
)
const moonIcon = icon(
    '<path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454z"/>'
)
const desktopIcon = icon(
    '<path d="M3 5a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-10z"/><path d="M7 20h10"/><path d="M9 16v4"/><path d="M15 16v4"/>'
)

/** `/language` or `/theme` link that sets the choice and returns to this page. */
const choiceLink = (route: string, to: string, next: string) =>
    `/${route}?${new URLSearchParams({ to, next }).toString()}`

/**
 * Language and theme menus below the card. Plain `details` and links (no
 * script): picking an entry navigates, which also closes the menu.
 */
const controls = (ctx: PageContext) => {
    const next = ctx.current ?? '/sign-in'
    const { copy } = ctx
    const languageMenu = html`<details class="menu" name="login-controls"><summary aria-label="${copy.language}: ${ctx.lang.toUpperCase()}">${languageIcon}<span>${ctx.lang.toUpperCase()}</span></summary><ul>${LANGUAGES.map(
        ({ code, label }) =>
            code === ctx.lang
                ? html`<li><span lang="${code}" aria-current="true">${label}</span></li>`
                : html`<li><a lang="${code}" href="${choiceLink('language', code, next)}">${label}</a></li>`
    )}</ul></details>`
    // No cookie means the device decides: the current choice is "system".
    const current = ctx.theme ?? 'system'
    const themes = [
        { code: 'light', label: copy.themeLight, icon: sunIcon },
        { code: 'dark', label: copy.themeDark, icon: moonIcon },
        { code: 'system', label: copy.themeSystem, icon: desktopIcon }
    ]
    const shown = themes.find((theme) => theme.code === current) ?? themes[2]
    const themeMenu = html`<details class="menu theme" name="login-controls"><summary aria-label="${copy.theme}: ${shown.label}">${shown.icon}</summary><ul>${themes.map(
        (theme) =>
            theme.code === current
                ? html`<li><span aria-current="true">${theme.icon}${theme.label}</span></li>`
                : html`<li><a href="${choiceLink('theme', theme.code, next)}">${theme.icon}${theme.label}</a></li>`
    )}</ul></details>`
    return html`<div class="controls">${languageMenu}${themeMenu}</div>`
}

function layout(
    ctx: PageContext,
    title: string,
    content: Html,
    options: { message?: Message; legal?: boolean; controls?: boolean } = {}
) {
    const message = options.message
        ? html`<p class="message ${options.message.kind}" role="${options.message.kind === 'error' ? 'alert' : 'status'}">${options.message.text}</p>`
        : ''
    // Only pages where the person signs in or creates an account agree to the terms.
    const legal = options.legal
        ? html`<footer>${ctx.copy.agreeBefore}<a href="${legalURL(ctx.lang, 'terms')}" target="_blank" rel="noopener noreferrer">${ctx.copy.terms}</a>${ctx.copy.agreeBetween}<a href="${legalURL(ctx.lang, 'privacy')}" target="_blank" rel="noopener noreferrer">${ctx.copy.privacy}</a>${ctx.copy.agreeAfter}</footer>`
        : ''
    return html`<!doctype html>
<html lang="${ctx.lang}"${ctx.theme ? html` data-theme="${ctx.theme}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="same-origin">
<title>${title} · HAWConnect</title>
<link rel="stylesheet" href="${ctx.stylesheet}">
</head>
<body>
<main class="card">
<div class="brand">${logo}<span>HAWConnect</span></div>
<h1>${title}</h1>
${message}
${content}
</main>
${legal}
${options.controls ? controls(ctx) : ''}
</body>
</html>
`.value
}

const flowField = (ctx: PageContext) =>
    ctx.flow
        ? html`<input type="hidden" name="oauth_query" value="${ctx.flow}">`
        : ''
/** A link to another login page that keeps the flow. */
const link = (ctx: PageContext, path: string) =>
    ctx.flow
        ? `${path}?${new URLSearchParams({ oauth_query: ctx.flow })}`
        : path
const emailInput = (ctx: PageContext, value = '') =>
    html`<label>${ctx.copy.email}<input type="email" name="email" autocomplete="email" required maxlength="254" value="${value}"></label>`
const passwordInput = (
    label: string,
    name: string,
    autocomplete: string,
    hint?: string
) =>
    html`<label>${label}<input type="password" name="${name}" autocomplete="${autocomplete}" required maxlength="${MAX_PASSWORD}"${autocomplete === 'new-password' ? html` minlength="${MIN_PASSWORD}"` : ''}></label>${hint ? html`<p class="hint">${hint}</p>` : ''}`

export function signInPage(
    ctx: PageContext,
    options: { email?: string; message?: Message } = {}
) {
    const { copy } = ctx
    return layout(
        ctx,
        copy.signInTitle,
        html`<form method="post" action="/sign-in">
${flowField(ctx)}
${emailInput(ctx, options.email)}
${passwordInput(copy.password, 'password', 'current-password')}
<button type="submit">${copy.signIn}</button>
</form>
<p class="links"><a href="${link(ctx, '/forgot-password')}">${copy.forgotPassword}</a></p>
<p class="links">${copy.noAccount} <a href="${link(ctx, '/create-account')}">${copy.signUp}</a></p>`,
        { message: options.message, legal: true, controls: true }
    )
}

export function createAccountPage(
    ctx: PageContext,
    options: { name?: string; email?: string; message?: Message } = {}
) {
    const { copy } = ctx
    return layout(
        ctx,
        copy.createAccountTitle,
        html`<form method="post" action="/create-account">
${flowField(ctx)}
<label>${copy.name}<input type="text" name="name" autocomplete="name" required maxlength="${MAX_NAME}" value="${options.name ?? ''}"></label>
${emailInput(ctx, options.email)}
${passwordInput(copy.password, 'password', 'new-password', fill(copy.passwordHint, { min: MIN_PASSWORD }))}
${passwordInput(copy.confirmPassword, 'confirm', 'new-password')}
<button type="submit">${copy.createAccount}</button>
</form>
<p class="links">${copy.haveAccount} <a href="${link(ctx, '/sign-in')}">${copy.signIn}</a></p>`,
        { message: options.message, legal: true, controls: true }
    )
}

/** "Check your email", with a button that sends the confirmation mail again. */
/**
 * After sign-up: asks for the 6-digit code from the mail. The address is known
 * from this browser (hidden field); without it, it is asked for as well.
 */
export function checkEmailPage(
    ctx: PageContext,
    options: { email?: string; message?: Message } = {}
) {
    const { copy } = ctx
    const email = options.email
        ? html`<input type="hidden" name="email" value="${options.email}">`
        : emailInput(ctx)
    return layout(
        ctx,
        copy.checkEmailTitle,
        html`<form method="post" action="/verify-code">
${flowField(ctx)}
${email}
<label>${copy.code}<input type="text" name="code" class="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required></label>
<button type="submit">${copy.confirmCode}</button>
</form>
${
    options.email
        ? html`<form method="post" action="/check-email">
${flowField(ctx)}
<input type="hidden" name="email" value="${options.email}">
<button type="submit" class="secondary">${copy.resendConfirmation}</button>
</form>`
        : ''
}
<p class="links"><a href="${link(ctx, '/sign-in')}">${copy.backToSignIn}</a></p>`,
        {
            message: options.message ?? {
                kind: 'notice',
                text: copy.checkEmail
            },
            controls: true
        }
    )
}

/** Opening the mail link only shows this button; the token is used on POST. */
export function confirmPage(ctx: PageContext, token: string) {
    const { copy } = ctx
    return layout(
        ctx,
        copy.confirmTitle,
        html`<p>${copy.confirmInstructions}</p>
<form method="post" action="/confirm">
${flowField(ctx)}
<input type="hidden" name="token" value="${token}">
<button type="submit">${copy.continue}</button>
</form>`,
        { controls: true }
    )
}

export function forgotPasswordPage(
    ctx: PageContext,
    options: { email?: string; message?: Message } = {}
) {
    const { copy } = ctx
    return layout(
        ctx,
        copy.resetTitle,
        html`<p>${copy.resetSubtitle}</p>
<form method="post" action="/forgot-password">
${flowField(ctx)}
${emailInput(ctx, options.email)}
<button type="submit">${copy.sendResetLink}</button>
</form>
<p class="links">${copy.rememberPassword} <a href="${link(ctx, '/sign-in')}">${copy.signIn}</a></p>`,
        { message: options.message, controls: true }
    )
}

export function resetPasswordPage(
    ctx: PageContext,
    token: string,
    options: { message?: Message } = {}
) {
    const { copy } = ctx
    return layout(
        ctx,
        copy.newPasswordTitle,
        html`<p>${copy.newPasswordSubtitle}</p>
<form method="post" action="/reset-password">
${flowField(ctx)}
<input type="hidden" name="token" value="${token}">
${passwordInput(copy.newPassword, 'password', 'new-password', fill(copy.passwordHint, { min: MIN_PASSWORD }))}
${passwordInput(copy.confirmPassword, 'confirm', 'new-password')}
<button type="submit">${copy.setNewPassword}</button>
</form>`,
        { message: options.message, controls: true }
    )
}

/** "Sign out of HAWConnect?": confirms ending the login-site session. */
export function signOutPage(
    ctx: PageContext,
    request: { clientId: string; postLogoutRedirectUri: string; state: string }
) {
    const { copy } = ctx
    const hiddenField = (name: string, value: string) =>
        value ? html`<input type="hidden" name="${name}" value="${value}">` : ''
    return layout(
        ctx,
        copy.signOutTitle,
        html`<p>${copy.signOutQuestion}</p>
<form method="post" action="/sign-out">
${hiddenField('client_id', request.clientId)}
${hiddenField('post_logout_redirect_uri', request.postLogoutRedirectUri)}
${hiddenField('state', request.state)}
<button type="submit">${copy.signOut}</button>
</form>`
    )
}

/** A page with a title, one text and an optional way back to sign-in. */
export function noticePage(
    ctx: PageContext,
    title: string,
    text: string,
    options: { backToSignIn?: boolean } = {}
) {
    return layout(
        ctx,
        title,
        html`<p>${text}</p>${options.backToSignIn ? html`<p class="links"><a href="${link(ctx, '/sign-in')}">${ctx.copy.backToSignIn}</a></p>` : ''}`
    )
}
