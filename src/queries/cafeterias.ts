import { GraphQLError } from 'graphql'
import { cafeteriaService } from '@/utils/cafeteria-refresh'

export const createCafeteriasQuery =
    (service: Pick<typeof cafeteriaService, 'get'>) =>
    async (_: unknown, args: { language?: string }) => {
        const language = args.language ?? 'de'
        if (language !== 'de' && language !== 'en')
            throw new GraphQLError('Unsupported cafeteria language')
        return service.get(language)
    }
export const cafeterias = createCafeteriasQuery(cafeteriaService)
