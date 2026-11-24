# HAWConnect Backend

<img src="config/api-docs/assets/logo.png" alt="HAWConnect logo" width="88" />

[![Lint](https://github.com/hawconnect/hawconnect-backend/actions/workflows/lint.yml/badge.svg?branch=main)](https://github.com/hawconnect/hawconnect-backend/actions/workflows/lint.yml)
[![Version](https://img.shields.io/github/package-json/v/hawconnect/hawconnect-backend/main?label=version)](package.json)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![API](https://img.shields.io/badge/API-GraphQL%20%7C%20REST-40296C.svg)](#getting-started)

**The API behind HAWConnect, the campus app for students of HAW Hamburg — built by students, for students.** It serves menus, events, news, clubs and semester dates to the app, runs accounts and the sign-in site, and powers the admin console.

> HAWConnect is an independent, student-maintained project. It is not an official service of HAW Hamburg.

## Contents

- [Features](#features)
- [How the project is organised](#how-the-project-is-organised)
- [Getting started](#getting-started)
- [Everyday commands](#everyday-commands)
- [Testing](#testing)
- [Database, configuration and deployment](#database-configuration-and-deployment)
- [Getting help](#getting-help)
- [Contributing and maintainers](#contributing-and-maintainers)
- [Contributors](#contributors)
- [License](#license)

## Features

| Area | What it provides |
| --- | --- |
| **Food** | Studierendenwerk Hamburg menus from the official German and English pages, for this and next week, with prices, allergens and labels; validated and cached so a source outage keeps the last good menu. Café and mensa opening hours. |
| **Campus life** | Official HAW events and news, Campus Life events from student organisers, and a managed club directory. |
| **Semester dates** | Lecture periods and holidays from HAW Hamburg's published calendars. |
| **Quick Links** | A managed, bilingual link directory the app shows on its links screen. |
| **Marketplace** | Student offers and requests with photos, messages, reports, moderation and automatic clean-up. |
| **Accounts** | Optional accounts (email, password and confirmation code), the sign-in site and encrypted-at-rest sync of calendars and preferences. |
| **Calendar downloads** | Fetches a student's private myHAW calendar export for import, without university credentials and without storing it. |
| **Administration** | The console's API: announcements, events, organiser profiles, clubs, Quick Links, permissions and an audit history. |
| **API documentation** | Generated GraphQL reference, served at `/backend-api`. |

Not part of the backend: authenticated HAW systems (grades, library accounts, myHAW login) and legal texts, which live on [hawconnect.de](https://hawconnect.de/en/legal/privacy).

## How the project is organised

HAWConnect is split into four repositories. This one is the backend.

| Repository | Folder | What it is |
| --- | --- | --- |
| [hawconnect/hawconnect-app](https://github.com/hawconnect/hawconnect-app) | `hawconnect` | Expo app for iOS, Android and web |
| [hawconnect/hawconnect-backend](https://github.com/hawconnect/hawconnect-backend) | `hawconnect-backend` | **This repository** — GraphQL/REST API, accounts and sign-in site, PostgreSQL, public-source ingestion |
| [hawconnect/hawconnect-console](https://github.com/hawconnect/hawconnect-console) | `hawconnect-console` | Admin console for staff and organisers |
| [hawconnect/hawconnect-docs](https://github.com/hawconnect/hawconnect-docs) | `hawconnect-website` | Landing page, documentation and legal pages ([hawconnect.de](https://hawconnect.de)) |

**Tech stack:** [Bun](https://bun.sh), Express, Apollo Server (GraphQL), PostgreSQL with Drizzle, Better Auth, Cheerio for scraping, Magidoc for API docs, GraphQL Codegen, Biome.

```text
index.ts            # HTTP server and refresh startup
src/
├── schema/         # GraphQL SDL (the API contract)
├── resolvers.ts    # GraphQL resolvers
├── scraping/       # Source parsers, fixtures and tests
├── utils/          # Refresh, validation and cache services
├── lib/            # Accounts, mail, sign-in and calendar services
├── login/          # Sign-in site
├── marketplace/    # Marketplace service and clean-up
├── admin/          # Console API, policies and audit
└── db/             # Migrations (app schema and account database)
```

## Getting started

### Prerequisites

- [Bun](https://bun.sh) **1.4.3** (see [`.bun-version`](.bun-version))
- Outbound HTTPS for the public sources
- PostgreSQL, only for accounts, the marketplace and managed content

### 1. Clone and install

```bash
mkdir HAWConnect && cd HAWConnect
git clone https://github.com/hawconnect/hawconnect-backend.git
cd hawconnect-backend
bun install --frozen-lockfile
```

The app expects this repository next to it at `../hawconnect-backend`.

### 2. Configure

```bash
cp .env.example .env.local
```

For local development with the app:

```dotenv
PORT=4000
HAWCONNECT_WEB_ORIGINS=http://localhost:3000,http://localhost:3001,http://localhost:8081
HAWCONNECT_AUTH_ORIGIN=http://localhost:4000
HAWCONNECT_WEB_ORIGIN=http://localhost:3000
HAWCONNECT_CONSOLE_ORIGIN=http://localhost:43127
```

Menus, events, news and semester dates work without any further settings. Accounts, the sign-in site, email, the marketplace and administration need more; see [docs/configuration.md](docs/configuration.md).

### 3. Run

```bash
bun dev           # hot-reloading server on port 4000
```

- GraphQL: `http://localhost:4000/graphql`
- API reference: `http://localhost:4000/backend-api`
- Sign-in site (when configured): `http://account.localhost:4000/sign-in`

## Everyday commands

| Command | What it does |
| --- | --- |
| `bun dev` | Start the server with hot reload |
| `bun start` | Start the server without hot reload |
| `bun run codegen` | Generate `src/__generated__/hawconnect-schema.graphql` from the SDL |
| `bun run lint` | Type-check and run Biome |
| `bun run fmt` | Format with Biome |
| `bun test` | Unit and integration tests |
| `bun run docs:dev` | Preview the API reference while editing it |
| `bun run <name>:migrate` | Apply a database migration (see [docs/database.md](docs/database.md)) |

After changing the GraphQL schema, run `bun run codegen` here and in the app.

## Testing

Tests live next to the code in `tests/` folders and run with `bun test`. Parsers are tested against saved source pages in `src/scraping/fixtures`. Database integration tests are skipped unless a disposable test database is configured; skipped tests are not evidence that an integration works. Never point tests at production data.

## Database, configuration and deployment

| Topic | Read |
| --- | --- |
| Environment settings: accounts, sign-in site, email, administration, marketplace, calendar downloads | [docs/configuration.md](docs/configuration.md) |
| Migrations, the app schema baseline, clubs and Quick Links | [docs/database.md](docs/database.md) |
| Staging and production on Coolify | [docs/deployment.md](docs/deployment.md) |
| Branches, staging checklist and releases | the app's [docs](https://github.com/hawconnect/hawconnect-app/tree/main/docs) |

Startup never runs migrations; apply them explicitly to the database you intend to change.

## Getting help

- **API reference:** `/backend-api` on a running backend.
- **Bugs and ideas:** open an issue in [GitHub Issues](https://github.com/hawconnect/hawconnect-backend/issues).
- **Security problems:** please report privately as described in [.github/SECURITY.md](.github/SECURITY.md).
- **Contact:** contact@hawconnect.de

## Contributing and maintainers

HAWConnect is maintained by students at HAW Hamburg, and contributions are welcome — code, translations, bug reports and ideas.

1. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the project conventions in [AGENTS.md](AGENTS.md).
2. Branch from `dev` (`feature/…`, `fix/…`), use [Conventional Commits](https://www.conventionalcommits.org/), and open a pull request into `dev`.
3. Please follow the [Code of Conduct](https://github.com/hawconnect/hawconnect-app/blob/main/.github/CODE_OF_CONDUCT.md).

## Contributors

HAWConnect is built by many contributors. GitHub keeps the current list for each repository:

- [App](https://github.com/hawconnect/hawconnect-app/graphs/contributors)
- [Backend](https://github.com/hawconnect/hawconnect-backend/graphs/contributors)
- [Console](https://github.com/hawconnect/hawconnect-console/graphs/contributors)
- [Docs](https://github.com/hawconnect/hawconnect-docs/graphs/contributors)

Want to join? See [Contribute](https://hawconnect.de/en/docs/contribute/contribute).

## License

HAWConnect is free software under the [GNU Affero General Public License v3.0](LICENSE).

### Source attribution

HAWConnect contains code adapted from the upstream Neuland campus application ecosystem, maintained by Neuland Ingolstadt e.V. Original copyright and licence notices in the incorporated source remain applicable. HAWConnect is independently maintained and does not claim upstream endorsement.
