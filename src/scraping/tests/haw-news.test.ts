import { expect, test } from 'bun:test'
import {
    HAW_NEWS_SOURCES,
    type HawNewsItem,
    parseHawArticleImage,
    parseHawNews,
    withArticleImages
} from '../haw-news'

const item = ({
    href = '/en/university/newsroom/news-details/news/news/show/most-cited/',
    title = 'Most cited: HAW Hamburg researchers rank among the top two percent',
    teaser = 'According to the so-called “Stanford List”, researchers are cited often.',
    image = '/fileadmin/_processed_/e/2/csm_Campus-Berliner_Tor-2018-31_bef97d2b95.jpg',
    credit = '&copy; Jonas Fischer / HAW Hamburg',
    date = ' 20.10.2026 | Press release | Research '
} = {}) =>
    `<div class="col-12 col-sm-4 col-xl-3 mb-5 news_item"><a class="smoothState" title="${title}" href="${href}"><div class="news_tile_inner d-print-none" style="background-image: url('${image}')"><span class="copyright-overlay">${credit}</span></div><div class="news_text"><div class="news-list-title">${title}</div><div class="news_teaser"><p>${teaser}</p></div></div></a><div class="news_date">${date}</div></div>`
const page = (...items: string[]) =>
    `<div class="news"><div class="news_list mb-5 "><div class="container"><div class="row"><div class="col-12"></div><!-- News displayed -->${items.join('')}</div></div></div></div>`

test('parses title, link, teaser, date, categories, image and credit', () => {
    const [news] = parseHawNews(page(item()), HAW_NEWS_SOURCES.en)

    expect(news).toEqual({
        id: '/en/university/newsroom/news-details/news/news/show/most-cited/',
        title: 'Most cited: HAW Hamburg researchers rank among the top two percent',
        url: 'https://www.haw-hamburg.de/en/university/newsroom/news-details/news/news/show/most-cited/',
        teaser: 'According to the so-called “Stanford List”, researchers are cited often.',
        date: '2026-10-20',
        categories: ['Press release', 'Research'],
        imageUrl:
            'https://www.haw-hamburg.de/fileadmin/_processed_/e/2/csm_Campus-Berliner_Tor-2018-31_bef97d2b95.jpg',
        imageCredit: 'Jonas Fischer / HAW Hamburg'
    })
})

test('keeps items without categories or image', () => {
    const [news] = parseHawNews(
        page(item({ date: ' 12.11.2026 ', image: '', credit: '' })),
        HAW_NEWS_SOURCES.de
    )

    expect(news.categories).toEqual([])
    expect(news.imageUrl).toBeNull()
    expect(news.imageCredit).toBeNull()
})

test('removes a "Foto:" or "Photo:" prefix from image credits', () => {
    for (const credit of [
        '&copy; Foto: Eshan',
        '© Photo: Eshan',
        'Foto: Eshan'
    ])
        expect(
            parseHawNews(page(item({ credit })), HAW_NEWS_SOURCES.de)[0]
                .imageCredit
        ).toBe('Eshan')
})

test('drops images hosted outside haw-hamburg.de', () => {
    const [news] = parseHawNews(
        page(item({ image: 'https://tracker.example/pixel.jpg' })),
        HAW_NEWS_SOURCES.en
    )

    expect(news.imageUrl).toBeNull()
})

test('rejects links that leave haw-hamburg.de or are not https', () => {
    expect(() =>
        parseHawNews(
            page(item({ href: 'javascript:alert(1)' })),
            HAW_NEWS_SOURCES.en
        )
    ).toThrow()
    expect(() =>
        parseHawNews(
            page(item({ href: 'https://evil.example/news/' })),
            HAW_NEWS_SOURCES.en
        )
    ).toThrow()
})

test('rejects invalid dates and changed page structure', () => {
    expect(() =>
        parseHawNews(page(item({ date: ' 31.02.2026 ' })), HAW_NEWS_SOURCES.en)
    ).toThrow()
    expect(() =>
        parseHawNews('<html>Service unavailable</html>', HAW_NEWS_SOURCES.en)
    ).toThrow()
    expect(() => parseHawNews(page(), HAW_NEWS_SOURCES.en)).toThrow()
})

test('parses the real English and German listing markup', async () => {
    for (const [file, source] of [
        ['haw-news-en.html', HAW_NEWS_SOURCES.en],
        ['haw-news-de.html', HAW_NEWS_SOURCES.de]
    ] as const) {
        const html = await Bun.file(
            new URL(`./fixtures/${file}`, import.meta.url)
        ).text()
        const news = parseHawNews(html, source)
        expect(news.length).toBeGreaterThan(0)
        for (const n of news) {
            expect(n.url.startsWith('https://www.haw-hamburg.de/')).toBe(true)
            expect(n.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
            expect(n.title.length).toBeGreaterThan(0)
        }
    }
})

const ARTICLE = 'https://www.haw-hamburg.de/detail/news/news/show/neue-wege/'
const article = (src: string) =>
    `<div class="news-single"><img itemprop="image" title="Foto" alt="Foto" src="${src}" width="817" height="460" /></div><img src="/typo3temp/assets/_processed_/2/5/csm_haw_logo_fc912ebd62.png" width="163" height="70" alt="" />`

test('finds the large article image on a HAW article page', () => {
    expect(
        parseHawArticleImage(
            article('/fileadmin/_processed_/1/1/csm_Foto_5aa46a8e55.jpg'),
            ARTICLE
        )
    ).toBe(
        'https://www.haw-hamburg.de/fileadmin/_processed_/1/1/csm_Foto_5aa46a8e55.jpg'
    )
})

test('ignores article images hosted elsewhere or missing', () => {
    expect(
        parseHawArticleImage(article('https://evil.example/x.jpg'), ARTICLE)
    ).toBeNull()
    expect(parseHawArticleImage('<p>No image</p>', ARTICLE)).toBeNull()
})

const newsItem = (imageUrl: string | null): HawNewsItem => ({
    id: '/detail/news/news/show/neue-wege/',
    title: 'Neue Wege',
    url: ARTICLE,
    teaser: null,
    date: '2026-11-12',
    categories: [],
    imageUrl,
    imageCredit: imageUrl ? 'HAW Hamburg' : null
})
const THUMB =
    'https://www.haw-hamburg.de/fileadmin/_processed_/1/1/csm_Foto_e8aba456eb.jpg'
const LARGE =
    'https://www.haw-hamburg.de/fileadmin/_processed_/1/1/csm_Foto_5aa46a8e55.jpg'

test('swaps the listing thumbnail for the article image', async () => {
    const fetched: string[] = []
    const [result] = await withArticleImages(
        [newsItem(THUMB)],
        async (url) => {
            fetched.push(url)
            return article(new URL(LARGE).pathname)
        },
        new Map()
    )

    expect(result?.imageUrl).toBe(LARGE)
    expect(result?.imageCredit).toBe('HAW Hamburg')
    expect(fetched).toEqual([ARTICLE])
})

test('keeps the thumbnail when the article page fails or has no image', async () => {
    const failed = await withArticleImages(
        [newsItem(THUMB)],
        async () => {
            throw Error('down')
        },
        new Map()
    )
    const empty = await withArticleImages(
        [newsItem(THUMB)],
        async () => '<p>No image</p>',
        new Map()
    )

    expect(failed[0]?.imageUrl).toBe(THUMB)
    expect(empty[0]?.imageUrl).toBe(THUMB)
})

test('does not open articles without a picture or already looked up', async () => {
    const fetched: string[] = []
    const known = new Map([[THUMB, LARGE]])
    const result = await withArticleImages(
        [newsItem(null), newsItem(THUMB)],
        async (url) => {
            fetched.push(url)
            return ''
        },
        known
    )

    expect(result.map((n) => n.imageUrl)).toEqual([null, LARGE])
    expect(fetched).toEqual([])
})
