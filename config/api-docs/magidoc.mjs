import path from 'node:path'
import { fileURLToPath } from 'node:url'
const relativePath = (target) => path.join(path.dirname(fileURLToPath(import.meta.url)),target)
export default {
    introspection: { type: 'sdl', paths: ['src/schema/*.gql'] },
    website: {
        template: './config/api-docs/template',
        staticAssets: relativePath('./assets'),
        output: relativePath('../../docs/out'),
        options: {
            appTitle: 'HAWConnect API',
            appLogo: '/logo.png?v=hawconnect-20261121',
            appFavicon: '/favicon.ico?v=hawconnect-20261121',
            siteMeta: { description: 'Student-maintained HAWConnect backend documentation', keywords: 'hawconnect,haw hamburg,graphql' },
            pages: [{ title: 'Backend API', content: `# HAWConnect API

Campus services for HAW Hamburg students.

## Endpoint

GraphQL: \`/graphql\` on this server (locally http://localhost:4000/graphql).

## Available services

- **Food:** menus and opening hours from Studierendenwerk Hamburg, in German and English.
- **Academic calendar:** semester and lecture dates from HAW Hamburg.
- **Events, clubs and news:** campus events, student clubs and HAW news.
- **Marketplace:** listings posted by students.
- **Accounts:** HAWConnect accounts sign in at account.hawconnect.de. They are separate from myHAW.

Fields marked as deprecated still work so that older app versions keep working. Use the replacement each one names.
` }],
            queryGenerationFactories: { LocalTime: '<23:30:50>', EmailAddress: '<test@example.com>', URL: '<https://example.com>', LocationInput: '["BerlinerTorMensa"]' }
        }
    }
}
