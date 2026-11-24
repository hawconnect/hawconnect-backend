-- Retire the WEB_DEV announcement platform: no separate development website exists.
ALTER TABLE "app_announcements" ALTER COLUMN "platform" SET DATA TYPE text[] USING "platform"::text[];--> statement-breakpoint
UPDATE "app_announcements" SET "platform" = array_remove("platform", 'WEB_DEV') WHERE 'WEB_DEV' = ANY("platform");--> statement-breakpoint
DROP TYPE "public"."app_platform";--> statement-breakpoint
CREATE TYPE "public"."app_platform" AS ENUM('ANDROID', 'IOS', 'WEB');--> statement-breakpoint
ALTER TABLE "app_announcements" ALTER COLUMN "platform" SET DATA TYPE "public"."app_platform"[] USING "platform"::"public"."app_platform"[];
