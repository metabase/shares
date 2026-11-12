-- Who can find a share in lists, search and collections. 1 (the default):
-- everyone who can read it. 0: its owner only; others need the link.
-- Independent of visibility, which says who can read it.
ALTER TABLE shares ADD COLUMN listed INTEGER NOT NULL DEFAULT 1 CHECK (listed IN (0, 1));
