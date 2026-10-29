-- Search of the web app (SHR-15): one FTS5 row per published share. The
-- D1+R2 store writes the row again in each batch that changes a share
-- (publish, attributes, rename, transfer, delete); see reindex() in
-- src/store/d1r2.ts. paths: the files of the live version; meta: keys and
-- JSON values of share_meta.
CREATE VIRTUAL TABLE share_search USING fts5(slug, title, collection, owner, paths, meta);

INSERT INTO share_search (slug, title, collection, owner, paths, meta)
  SELECT s.slug, coalesce(s.title, ''), coalesce(s.collection, ''), s.owner,
    coalesce((SELECT group_concat(path, ' ') FROM files WHERE share = s.slug AND version = s.current_version), ''),
    coalesce((SELECT group_concat(key || ' ' || value, ' ') FROM share_meta WHERE share = s.slug), '')
  FROM shares s WHERE s.current_version IS NOT NULL;
