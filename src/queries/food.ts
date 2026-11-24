import { GraphQLError } from 'graphql'
import { hamburgFoodService } from '@/utils/food-refresh'

const locations = ['BerlinerTorMensa', 'BergedorfMensa', 'FinkenauMensa']
export const createFoodQuery =
    (service: Pick<typeof hamburgFoodService, 'get'>) =>
    async (_: unknown, args: { locations: string[]; language?: string }) => {
        if (args.locations.some((location) => !locations.includes(location)))
            throw new GraphQLError('Unsupported Hamburg cafeteria')
        const snapshot = await service.get()
        const language = args.language ?? 'de'
        if (!['de', 'en'].includes(language))
            throw new GraphQLError('Unsupported food language')
        if (language === 'en' && !snapshot.englishFoodData)
            throw new GraphQLError('English food source unavailable')
        const foodData =
            language === 'en' ? snapshot.englishFoodData! : snapshot.foodData
        return {
            ...snapshot,
            translationFallback:
                language === 'en' ? false : snapshot.translationFallback,
            foodData: foodData.map((day) => ({
                ...day,
                meals: day.meals
                    .filter((meal) => args.locations.includes(meal.restaurant))
                    // Snapshots persisted before icons existed lack the field: serve
                    // null (unknown), never an empty list that reads as "no icons".
                    .map((meal) => ({ ...meal, icons: meal.icons ?? null }))
            })),
            errors: snapshot.available
                ? snapshot.errors
                : [{ location: 'Hamburg', message: 'Food source unavailable' }]
        }
    }
export const food = createFoodQuery(hamburgFoodService)

export const createCanteensQuery =
    (service: Pick<typeof hamburgFoodService, 'get'>) =>
    async (_: unknown, args: { language?: string }) => {
        const language = args.language ?? 'de'
        if (!['de', 'en'].includes(language))
            throw new GraphQLError('Unsupported food language')
        const snapshot = await service.get()
        return (
            (language === 'en'
                ? snapshot.englishCanteens
                : snapshot.canteens) ?? []
        )
    }
export const canteens = createCanteensQuery(hamburgFoodService)
