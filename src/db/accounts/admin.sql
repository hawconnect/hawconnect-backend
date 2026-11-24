-- Additive dashboard permissions; campus content remains in existing tables.
CREATE TABLE IF NOT EXISTS haw_admin_roles (
 email text PRIMARY KEY CONSTRAINT haw_admin_roles_email_check CHECK (email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
 capabilities text[] NOT NULL DEFAULT '{}',
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (capabilities <@ ARRAY['announcements','events','ops','audit','marketplace','admin']::text[])
);
-- Existing installs: widen the capability check to include 'marketplace' (idempotent).
ALTER TABLE haw_admin_roles DROP CONSTRAINT IF EXISTS haw_admin_roles_capabilities_check;
ALTER TABLE haw_admin_roles ADD CONSTRAINT haw_admin_roles_capabilities_check
 CHECK (capabilities <@ ARRAY['announcements','events','ops','audit','marketplace','admin']::text[]);
-- Existing installs: any lower-case address may hold a grant, not only @haw-hamburg.de (idempotent).
ALTER TABLE haw_admin_roles DROP CONSTRAINT IF EXISTS haw_admin_roles_email_check;
ALTER TABLE haw_admin_roles ADD CONSTRAINT haw_admin_roles_email_check
 CHECK (email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$');
