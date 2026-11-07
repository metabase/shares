-- Who can read a share. private: the owner only. org: every signed-in user
-- of ALLOWED_DOMAIN (the default). public: org, plus anonymous readers
-- while PUBLIC_SHARING is on. The old column `public` is not read any more;
-- a later migration drops it.
ALTER TABLE shares ADD COLUMN visibility TEXT NOT NULL DEFAULT 'org'
  CHECK (visibility IN ('private', 'org', 'public'));

UPDATE shares SET visibility = 'public' WHERE public = 1;
