# Backend deployment: staging and production

Two Coolify applications from this repository, both built from `/Dockerfile` (port 4000), each with its own PostgreSQL database, persistent volume and secrets. The overall workflow (branches, staging checklist, releases) is described in the app repository's `docs/`.

| | Staging | Production |
| --- | --- | --- |
| Branch tracked by Coolify | `dev` | `main` |
| Domains | `dev-api.hawconnect.de`, `dev-account.hawconnect.de` | `api.hawconnect.de`, `account.hawconnect.de` |
| PostgreSQL | separate staging database (own Coolify resource) | production database |
| Volume at `/var/lib/hawconnect` | staging volume | production volume |

## Environment variables

| Variable | Staging | Production |
| --- | --- | --- |
| `NODE_ENV` | `production` | `production` |
| `HAWCONNECT_AUTH_ORIGIN` | `https://dev-api.hawconnect.de` | `https://api.hawconnect.de` |
| `HAWCONNECT_LOGIN_ORIGIN` | `https://dev-account.hawconnect.de` | `https://account.hawconnect.de` |
| `HAWCONNECT_WEB_ORIGINS` | `https://dev-app.hawconnect.de` | `https://app.hawconnect.de` |
| `HAWCONNECT_CONSOLE_ORIGIN` | `https://dev-console.hawconnect.de` | `https://console.hawconnect.de` |
| `HAWCONNECT_ACCOUNTS_DATABASE_URL` / `DB_HOST`, `DB_PORT`, `POSTGRES_*` | staging database | production database |
| `HAWCONNECT_ACCOUNT_SECRET`, `HAWCONNECT_SYNC_ENCRYPTION_KEY`, `HAWCONNECT_MARKETPLACE_BLOCK_SECRET` | newly generated for staging | production values |
| `HAWCONNECT_ADMIN_EMAILS` | staging admins | production admins |
| SMTP settings | test mailbox or the same provider with a staging sender | production |

Generate every staging secret fresh (e.g. `openssl rand -base64 48`); never copy a production secret into staging. A staging database URL must never point at the production database.

## Migrations

Migrations are not run on startup. After deploying a schema change:

1. Run it on staging: `bun run migrate` (and `bun run accounts:migrate` / `bun run admin:migrate` when those change) in the staging container.
2. Check staging with the staging checklist.
3. Run the same commands on production after the `dev` → `main` merge.

## Health check and storage

The image includes `curl`; point the Coolify health check at the API. Food, events and cafeteria snapshots are written to `/var/lib/hawconnect` — mount a persistent volume there (separately per environment). Volumes are not backups; back up the databases.
