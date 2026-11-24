import { HAW_NEWS_SOURCES } from '@/scraping/haw-news'
import { hawNewsServices } from '@/utils/haw-news'

export async function hawNews(_: unknown, args: { language?: string }) {
    const language = args.language === 'en' ? 'en' : 'de'
    return {
        ...(await hawNewsServices[language].get()),
        language,
        sourceUrl: HAW_NEWS_SOURCES[language]
    }
}
