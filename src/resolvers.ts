import { GraphQLScalarType, Kind } from 'graphql'
import {
    DateTimeResolver,
    EmailAddressResolver,
    LocalEndTimeResolver,
    URLResolver
} from 'graphql-scalars'
import { marketplaceResolvers } from '@/marketplace/runtime'
import { accountSnapshot, accountSync } from '@/queries/account-sync'
import { cafeterias } from '@/queries/cafeterias'
import { campusLifeEvents } from '@/queries/campus-life'
import { canteens, food } from '@/queries/food'
import { hawEvents } from '@/queries/haw-events'
import { hawNews } from '@/queries/haw-news'
import { academicCalendarService } from '@/utils/academic-calendar'
import { hawClubs } from '@/utils/haw-clubs'

import { appAnnouncementsQuery } from './queries/appAnnouncements'

const LocationInput = new GraphQLScalarType({
    name: 'LocationInput',
    description:
        'Custom food input scalar type for handling both enum values and strings. This is used for the migration of the food query to the new schema.',
    parseValue(value) {
        return value // Value from the client input variables
    },
    serialize(value) {
        return value // Value sent to the client
    },
    parseLiteral(ast) {
        if (ast.kind === Kind.STRING) {
            const value = ast.value
            return value // String value
        }
        if (ast.kind === Kind.ENUM) {
            return ast.value
        }

        throw new Error('LocationInput must be a string or a valid enum value')
    }
})

export const resolvers = {
    Query: {
        campusLifeEvents,
        hawEvents,
        hawNews,
        academicCalendar: () => academicCalendarService.get(),
        accountSnapshot,
        food,
        canteens,
        cafeterias,
        appAnnouncements: appAnnouncementsQuery,
        hawClubs: (_: unknown, args: { language?: string }) =>
            hawClubs(args.language),
        ...marketplaceResolvers.Query
    },
    Mutation: {
        accountSync,
        ...marketplaceResolvers.Mutation
    },
    LocalTime: LocalEndTimeResolver,
    DateTime: DateTimeResolver,
    EmailAddress: EmailAddressResolver,
    URL: URLResolver,
    LocationInput
}
