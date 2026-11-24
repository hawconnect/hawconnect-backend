CREATE TABLE IF NOT EXISTS haw_quick_links (
 id integer PRIMARY KEY CHECK (id=1),
 links jsonb NOT NULL,
 version text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
-- Existing installs: the myHAW link's ID was THI's portal name "primuss". Rename it in
-- place (same position, title and URL) unless a "myhaw" entry already exists (idempotent).
UPDATE haw_quick_links
SET links = (
        SELECT jsonb_agg(
            CASE WHEN e->>'key' = 'primuss' THEN jsonb_set(e, '{key}', '"myhaw"') ELSE e END
            ORDER BY ord
        )
        FROM jsonb_array_elements(links) WITH ORDINALITY AS t(e, ord)
    ),
    version = gen_random_uuid()::text,
    updated_at = now()
WHERE links @> '[{"key": "primuss"}]'
  AND NOT links @> '[{"key": "myhaw"}]';
