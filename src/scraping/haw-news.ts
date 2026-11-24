import { load } from 'cheerio'

/** Public HAW Hamburg news listings. The German and English pages carry different articles. */
export const HAW_NEWS_SOURCES = {
    de: 'https://www.haw-hamburg.de/newsroom/alle-nachrichten/',
    en: 'https://www.haw-hamburg.de/en/university/newsroom/news/'
} as const
export type HawNewsLanguage = keyof typeof HAW_NEWS_SOURCES

export interface HawNewsItem {
    id: string
    title: string
    url: string
    teaser: string | null
    date: string
    categories: string[]
    imageUrl: string | null
    imageCredit: string | null
}

const HAW_ORIGIN = 'https://www.haw-hamburg.de'
const clean = (s: string) => s.replace(/\s+/g, ' ').trim()

function isoDate(value: string) {
    const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value)
    if (!m) throw Error('Invalid HAW news date')
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const date = new Date(Date.UTC(y, mo - 1, d))
    if (
        date.getUTCDate() !== d ||
        date.getUTCMonth() !== mo - 1 ||
        date.getUTCFullYear() !== y
    )
        throw Error('Invalid HAW news date')
    return date.toISOString().slice(0, 10)
}

/** Images are only kept when served by haw-hamburg.de itself. */
function hawImage(style: string | undefined, source: string) {
    const raw = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(style ?? '')?.[1]
    return hawUrl(raw, source)
}

function hawUrl(raw: string | undefined, source: string) {
    if (!raw) return null
    try {
        const url = new URL(raw, source)
        return url.origin === HAW_ORIGIN ? url.href : null
    } catch {
        return null
    }
}

export function parseHawNews(html: string, source: string): HawNewsItem[] {
    const $ = load(html)
    const list = $('.news_list').first()
    if (!list.length) throw Error('HAW news listing structure changed')
    const items: HawNewsItem[] = []
    list.find('.news_item').each((_, node) => {
        const el = $(node)
        const link = el.find('a[href]').first()
        const href = link.attr('href')
        const title = clean(el.find('.news-list-title').text())
        const [dateLabel, ...categories] = clean(el.find('.news_date').text())
            .split('|')
            .map(clean)
        if (!href || !title || !dateLabel) throw Error('Invalid HAW news item')
        const url = new URL(href, source)
        if (
            url.origin !== HAW_ORIGIN ||
            Boolean(url.username) ||
            Boolean(url.password)
        )
            throw Error('Unexpected HAW news link')
        url.search = ''
        url.hash = ''
        const tile = el.find('.news_tile_inner').first()
        const imageUrl = hawImage(tile.attr('style'), source)
        const credit = clean(tile.find('.copyright-overlay').text()).replace(
            /^(?:©\s*)?(?:(?:foto|photo)\s*:\s*)?/i,
            ''
        )
        items.push({
            id: url.pathname,
            title,
            url: url.href,
            teaser: clean(el.find('.news_teaser').text()) || null,
            date: isoDate(dateLabel),
            categories: categories.filter(Boolean),
            imageUrl,
            imageCredit: imageUrl && credit ? credit : null
        })
    })
    if (!items.length) throw Error('Unverified empty HAW news listing')
    return items
}

/** The article's own photo: the same picture as the listing thumbnail, about three times larger. */
export function parseHawArticleImage(html: string, source: string) {
    return hawUrl(
        load(html)('img[itemprop="image"]').first().attr('src'),
        source
    )
}

/**
 * Replaces each listing thumbnail (255 px wide) with the article page's
 * image. `known` maps thumbnails to images already found, so each article is
 * opened once; an article that fails or has no image keeps its thumbnail.
 */
export async function withArticleImages(
    items: HawNewsItem[],
    loadArticle: (url: string) => Promise<string>,
    known: Map<string, string>
) {
    const result: HawNewsItem[] = []
    for (const item of items) {
        const thumbnail = item.imageUrl
        if (!thumbnail) {
            result.push(item)
            continue
        }
        let large = known.get(thumbnail)
        if (!large) {
            try {
                large =
                    parseHawArticleImage(
                        await loadArticle(item.url),
                        item.url
                    ) ?? undefined
            } catch {
                large = undefined
            }
            if (large) known.set(thumbnail, large)
        }
        result.push({ ...item, imageUrl: large ?? thumbnail })
    }
    return result
}
