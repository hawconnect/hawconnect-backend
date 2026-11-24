CREATE TABLE IF NOT EXISTS haw_market_post (
 id uuid PRIMARY KEY,
 owner_id text NOT NULL REFERENCES haw_user(id) ON DELETE CASCADE,
 type text NOT NULL CHECK (type IN ('offer','request')),
 category text NOT NULL CONSTRAINT haw_market_post_category_check CHECK (category IN ('housing','jobs')),
 title text NOT NULL,
 description text NOT NULL,
 price_eur integer,
 price_free boolean NOT NULL DEFAULT false,
 price_unit text CHECK (price_unit IS NULL OR price_unit IN ('once','perMonth','perHour')),
 location text,
 available_from date,
 status text NOT NULL CONSTRAINT haw_market_post_status_check CHECK (status IN ('active','reserved','closed','expired','removedByOwner','removedByModerator','hiddenPendingReview','hiddenByBlock')),
 details jsonb NOT NULL DEFAULT '{}'::jsonb,
 report_count integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS haw_market_post_status_created_idx ON haw_market_post(status, created_at DESC);
CREATE INDEX IF NOT EXISTS haw_market_post_owner_idx ON haw_market_post(owner_id);

CREATE TABLE IF NOT EXISTS haw_market_photo (
 id uuid PRIMARY KEY,
 post_id uuid REFERENCES haw_market_post(id) ON DELETE CASCADE,
 owner_id text NOT NULL REFERENCES haw_user(id) ON DELETE CASCADE,
 object_key text NOT NULL UNIQUE,
 position smallint,
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS haw_market_rules (
 user_id text PRIMARY KEY REFERENCES haw_user(id) ON DELETE CASCADE,
 version integer NOT NULL,
 accepted_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS haw_market_message (
 id uuid PRIMARY KEY,
 post_id uuid NOT NULL REFERENCES haw_market_post(id) ON DELETE CASCADE,
 sender_id text NOT NULL REFERENCES haw_user(id) ON DELETE CASCADE,
 recipient_id text NOT NULL REFERENCES haw_user(id) ON DELETE CASCADE,
 body text NOT NULL,
 report_token text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS haw_market_report (
 id uuid PRIMARY KEY,
 post_id uuid REFERENCES haw_market_post(id) ON DELETE SET NULL,
 message_id uuid REFERENCES haw_market_message(id) ON DELETE SET NULL,
 reporter_id text REFERENCES haw_user(id) ON DELETE SET NULL,
 reason text NOT NULL CHECK (reason IN ('scam','illegal','offensive','discrimination','spam','other')),
 note text,
 snapshot jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 decided_at timestamptz,
 decision text,
 decided_by text
);
-- Durable report kind: message_id is nulled when the message is deleted, so it cannot tell the kinds apart.
ALTER TABLE haw_market_report ADD COLUMN IF NOT EXISTS kind text;
UPDATE haw_market_report SET kind = CASE WHEN message_id IS NOT NULL OR (snapshot IS NOT NULL AND snapshot ? 'body') THEN 'message' ELSE 'post' END WHERE kind IS NULL;
ALTER TABLE haw_market_report ALTER COLUMN kind SET NOT NULL;
ALTER TABLE haw_market_report DROP CONSTRAINT IF EXISTS haw_market_report_kind_check;
ALTER TABLE haw_market_report ADD CONSTRAINT haw_market_report_kind_check CHECK (kind IN ('post','message'));
DROP INDEX IF EXISTS haw_market_report_post_reporter_uniq;
CREATE UNIQUE INDEX haw_market_report_post_reporter_uniq ON haw_market_report(post_id, reporter_id) WHERE kind = 'post';

CREATE TABLE IF NOT EXISTS haw_market_block (
 id uuid PRIMARY KEY,
 user_id text REFERENCES haw_user(id) ON DELETE SET NULL,
 email_hash text NOT NULL,
 reason text NOT NULL,
 until timestamptz NOT NULL,
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 lifted_at timestamptz
);
CREATE INDEX IF NOT EXISTS haw_market_block_email_hash_idx ON haw_market_block(email_hash);
CREATE INDEX IF NOT EXISTS haw_market_block_user_idx ON haw_market_block(user_id);
CREATE INDEX IF NOT EXISTS haw_market_photo_post_idx ON haw_market_photo(post_id);
CREATE INDEX IF NOT EXISTS haw_market_photo_owner_idx ON haw_market_photo(owner_id);
CREATE INDEX IF NOT EXISTS haw_market_message_sender_created_idx ON haw_market_message(sender_id, created_at);
CREATE INDEX IF NOT EXISTS haw_market_message_post_idx ON haw_market_message(post_id);
CREATE INDEX IF NOT EXISTS haw_market_report_message_idx ON haw_market_report(message_id);

-- Photo purge queue: every deleted photo row (account cascade, post purge, detach on edit,
-- unattached cleanup) leaves its object key here until R2 confirms the object is gone.
CREATE TABLE IF NOT EXISTS haw_market_photo_purge (
 object_key text PRIMARY KEY,
 queued_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS haw_market_photo_purge_queued_idx ON haw_market_photo_purge(queued_at, object_key);
CREATE OR REPLACE FUNCTION haw_market_photo_enqueue_purge() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO haw_market_photo_purge(object_key) VALUES (OLD.object_key) ON CONFLICT (object_key) DO NOTHING;
 RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS haw_market_photo_enqueue_purge ON haw_market_photo;
CREATE TRIGGER haw_market_photo_enqueue_purge BEFORE DELETE ON haw_market_photo
 FOR EACH ROW EXECUTE FUNCTION haw_market_photo_enqueue_purge();

-- The reported person (post owner or message sender), kept after the post or message is deleted.
ALTER TABLE haw_market_report ADD COLUMN IF NOT EXISTS subject_user_id text REFERENCES haw_user(id) ON DELETE SET NULL;
UPDATE haw_market_report r SET subject_user_id = m.sender_id
 FROM haw_market_message m
 WHERE r.subject_user_id IS NULL AND r.kind = 'message' AND m.id = r.message_id;
UPDATE haw_market_report r SET subject_user_id = p.owner_id
 FROM haw_market_post p
 WHERE r.subject_user_id IS NULL AND r.kind = 'post' AND p.id = r.post_id;
CREATE INDEX IF NOT EXISTS haw_market_report_subject_idx ON haw_market_report(subject_user_id);

-- Statement of reasons for a removal; deleted with the report by the one-year retention purge.
ALTER TABLE haw_market_report ADD COLUMN IF NOT EXISTS decision_reason text;

-- Listings carry category-specific details (jsonb); campus is gone; only housing and jobs remain.
ALTER TABLE haw_market_post ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE haw_market_post DROP CONSTRAINT IF EXISTS haw_market_post_category_check;
-- The marketplace was never deployed (local test data only), so rows of removed categories are deleted.
-- Photo objects of deleted rows are not removed from storage (local data only).
DELETE FROM haw_market_post WHERE category NOT IN ('housing','jobs');
ALTER TABLE haw_market_post ADD CONSTRAINT haw_market_post_category_check CHECK (category IN ('housing','jobs'));
ALTER TABLE haw_market_post DROP CONSTRAINT IF EXISTS haw_market_post_status_check;
ALTER TABLE haw_market_post ADD CONSTRAINT haw_market_post_status_check CHECK (status IN ('active','reserved','closed','expired','removedByOwner','removedByModerator','hiddenPendingReview','hiddenByBlock'));
ALTER TABLE haw_market_post DROP COLUMN IF EXISTS campus;
