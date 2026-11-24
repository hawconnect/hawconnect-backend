# Database and migrations

Startup never applies migrations. Back up and check the target database before any schema change, and run each migration explicitly against the database you intend to change.

## Migration commands

| Command | What it creates or updates |
| --- | --- |
| `bun run migrate` | App schema (events and related tables) from the baseline in `src/db/migrations` |
| `bun run accounts:migrate` | Accounts, sessions, sign-in tables and sync storage; registers the configured sign-in clients |
| `bun run admin:migrate` | Administrator roles and permissions |
| `bun run organizers:migrate` | Campus Life organizer profiles |
| `bun run clubs:migrate` | Managed club directory |
| `bun run legal:migrate` | Former legal documents table (kept for existing databases; the backend no longer reads it) |
| `bun run quick-links:migrate` | Managed Quick Links |
| `bun run marketplace:migrate` | Marketplace listings, photos, messages, reports and blocks |

The account-database migrations are additive and safe to rerun: they create missing tables and keep existing rows. Do not replay every command blindly against an existing database; check its history and schema first.

## App schema baseline

The app-schema migration chain starts at `src/db/migrations/0000_hawconnect_baseline.sql`. It creates five app tables; account, sync and administrator migrations are separate.

**The baseline is not an upgrade path for existing databases.** For an empty database, review the target and run `bun run migrate`. The runner takes an advisory lock and checks recognised history before applying anything. A database with unknown history or existing public tables, views, sequences or types fails with `ExistingDatabaseRequiresMigrationAdoption` and nothing is applied.

If that happens, stop and keep a backup of the existing schema and journal. A maintainer must review a separate adoption procedure. Do not drop tables, delete the journal, rerun old migrations or add baseline hashes by hand. Rerunning a recognised baseline keeps existing rows.

Migration tests need `HAWCONNECT_MIGRATION_TEST_URL` pointing to a disposable local PostgreSQL database named `hawconnect_migration_test`:

```bash
bun test src/utils/tests/migration-baseline.test.ts src/utils/tests/migration-baseline-integration.test.ts
```

The integration suite resets only its own test schemas; never point it at valuable data.

## Clubs

The Ops-protected `/api/admin/clubs` endpoints manage the club directory: sanitised rich text, HTTPS image URLs and authored German and English translations. Clubs are stored only in the database (`haw_club_content`); nothing is scraped. GraphQL `hawClubs` serves stored entries, with plain descriptions for older clients. Translations fall back to the other authored language, never to machine translation. Saves and deletes require the current version and are audited in the same transaction; deleting a club removes all its translations.

If the table is missing, the public directory is empty and administrators get `ClubsSetupRequired`. Temporary database failures keep the last directory in memory and mark it stale. Image uploads go through the console's R2 workflow; the backend stores validated HTTPS image references only.

### Importing the initial clubs once

`src/data/initial-clubs.json` holds a reviewed snapshot of ten clubs with paired German and English translations. The import reads only this file. Check it without database access first:

```bash
bun run clubs:import-existing
```

After confirming which database you are writing to:

```bash
bun run clubs:migrate
bun run clubs:import-existing --apply
```

The import sanitises every translation, creates managed entries and audits them in one transaction. Clubs that already exist are kept untouched and reported in `keptClubs`. Repeated runs do nothing after the first successful import; a failed run leaves no partial import.

## Quick Links

`bun run quick-links:migrate` creates `haw_quick_links` and seeds the existing ten links only when the directory has never been set up. Rerunning keeps edits and an intentionally empty directory.

Public clients read `GET /api/quick-links`. Ops and administrator accounts edit the ordered bilingual directory through `/api/admin/quick-links`; saves require the current version and are audited. Only allow-listed icon keys and HTTPS URLs without embedded credentials are accepted. A save publishes immediately. Until the endpoint is available, the app uses its bundled starter links.
