# Backend configuration

Environment settings for local development and servers. Copy `.env.example` to `.env.local` and fill in what you need. Restart the backend after changing environment values; editing `.env.local` does not update a running process or a Coolify deployment. Never commit secrets or put them in public app variables.

For staging and production values, see [deployment.md](deployment.md).

## Local development

```dotenv
PORT=4000
HAWCONNECT_WEB_ORIGINS=http://localhost:3000,http://localhost:3001,http://localhost:8081
HAWCONNECT_AUTH_ORIGIN=http://localhost:4000
HAWCONNECT_WEB_ORIGIN=http://localhost:3000
HAWCONNECT_CONSOLE_ORIGIN=http://localhost:43127
```

Use port 3001 for `HAWCONNECT_WEB_ORIGIN` when testing the local static web preview there.

Public sources (menus, events, news, semester dates) need only outbound HTTPS. Accounts, the marketplace, clubs, Quick Links and other managed content need the database below.

## Accounts and database

```dotenv
HAWCONNECT_ACCOUNTS_DATABASE_URL=postgres://USER:PASSWORD@HOST:PORT/DATABASE
HAWCONNECT_ACCOUNT_SECRET=REPLACE_WITH_A_RANDOM_SECRET
HAWCONNECT_SYNC_ENCRYPTION_KEY=REPLACE_WITH_BASE64_OF_32_RANDOM_BYTES
HAWCONNECT_ADMIN_EMAILS=maintainer@example.org
```

The database URL is used for both account and campus-content access. Separate `DB_HOST`, `DB_PORT`, `POSTGRES_DB`, `POSTGRES_USER` and `POSTGRES_PASSWORD` settings are fallbacks only. Keep existing sync encryption keys when moving data and back them up separately; synchronised data is encrypted on the server, not end-to-end.

## Sign-in site

The sign-in site (`account.hawconnect.de` in production) is served by this backend on a separate host name.

```dotenv
HAWCONNECT_LOGIN_ORIGIN=http://account.localhost:4000
# At least 32 random characters, e.g. `openssl rand -hex 32`
HAWCONNECT_OIDC_SECRET_HAWCONNECT_APP=
```

Run `bun run accounts:migrate` once (and after updates) to create the login tables and register the app's sign-in client. In the app, set `EXPO_PUBLIC_HAWCONNECT_LOGIN_URL` to the same origin.

`account.localhost` resolves to 127.0.0.1 by itself in Chrome and Firefox only. Safari and the iOS Simulator need a hosts entry (`127.0.0.1 account.localhost`). On an Android emulator, forward the port with `adb reverse tcp:4000 tcp:4000`; the emulator's own `localhost` is the emulator, not the Mac.

Registering the sign-in client writes it to the configured database. Do not point a local backend with a local secret at a database that a deployed backend also uses.

## Email

```dotenv
HAWCONNECT_SMTP_HOST=YOUR_SMTP_HOST
HAWCONNECT_SMTP_PORT=587
HAWCONNECT_SMTP_USER=YOUR_SMTP_USERNAME
HAWCONNECT_SMTP_PASSWORD=YOUR_SMTP_PASSWORD
HAWCONNECT_MAIL_FROM="HAWConnect <YOUR_AUTHORISED_SENDER>"
```

Port 587 uses STARTTLS; 465 uses implicit TLS. The sender address must be authorised by the provider. Successful SMTP authentication does not prove that mail is accepted or delivered.

## Administration

Administrator access requires an explicit bootstrap grant in `HAWCONNECT_ADMIN_EMAILS` or a delegated capability; an email domain alone grants nothing. Set an administrator's password with `bun run admin:set-password`, passing the password through stdin, never as a command argument. The account must already exist and be verified.

## Marketplace

```dotenv
# At least 32 random characters
HAWCONNECT_MARKETPLACE_BLOCK_SECRET=
# Private bucket for listing photos (not the console's public bucket)
HAWCONNECT_MARKETPLACE_R2_ACCOUNT_ID=
HAWCONNECT_MARKETPLACE_R2_ACCESS_KEY_ID=
HAWCONNECT_MARKETPLACE_R2_SECRET_ACCESS_KEY=
HAWCONNECT_MARKETPLACE_R2_BUCKET=
# Development only: store photos in a local folder instead of R2
# HAWCONNECT_MARKETPLACE_LOCAL_PHOTOS_DIR=.cache/marketplace-photos
```

Without the block secret and a photo store, the marketplace is disabled and its GraphQL operations return `MarketplaceUnavailable`. Create its tables with `bun run marketplace:migrate`.

## Private calendar downloads

`POST /api/calendar/myhaw` accepts a bounded JSON body containing a private myHAW export URL. Only the permitted HTTPS myHAW export endpoint is fetched. The route rejects redirects, does not forward university credentials and does not intentionally store or log calendar contents. Limits: 15 seconds, 2 MB, ten requests per IP per minute and eight concurrent downloads per process. Reverse proxies and monitoring must also keep request bodies and private links out of logs.

## Legal pages

The backend serves no legal content. Privacy policy, imprint and terms live in the [hawconnect-docs](https://github.com/hawconnect/hawconnect-docs) repository and are published at `https://hawconnect.de/{de,en}/legal/{privacy,imprint,terms}`; the sign-in site links there.
