import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const template = join(import.meta.dir, '../../../config/api-docs/template')
const css = readFileSync(join(template, 'src/app.css'), 'utf8')

const block = (theme: string) => {
    const re = new RegExp(`\\[theme='${theme}'\\]\\s*\\{([^}]*)\\}`, 'g')
    const bodies = [...css.matchAll(re)].map((m) => m[1])
    expect(bodies.length).toBeGreaterThan(0)
    return bodies.join('\n').toLowerCase()
}

describe('api docs theme', () => {
    test('primary interactive colour is purple in both Carbon themes', () => {
        expect(block('white')).toContain('--cds-interactive-01: #40296c')
        expect(block('g100')).toContain('--cds-interactive-01: #ac97d3')
        expect(block('white')).toContain('--cds-link-01: #40296c')
        expect(block('g100')).toContain('--cds-link-01: #ac97d3')
    })

    test('uses Outfit and leaves no Carbon blue override', () => {
        expect(css).toContain('Outfit')
        expect(css.toLowerCase()).not.toContain('#0f62fe')
        expect(css).not.toMatch(/rgb\(98, ?156, ?255/)
    })

    test('ships the Outfit font files', () => {
        for (const w of [400, 500, 600, 700]) {
            expect(
                existsSync(
                    join(
                        template,
                        `static/fonts/outfit-latin-${w}-normal.woff2`
                    )
                )
            ).toBe(true)
        }
        expect(existsSync(join(template, 'static/fonts/OFL.txt'))).toBe(true)
    })
})
