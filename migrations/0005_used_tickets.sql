-- Nonces of redeemed content host login tickets, so a ticket sets the content cookie once.
-- A row lives until its ticket has expired, and each redeem deletes the expired rows.
CREATE TABLE used_tickets (
  nonce      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL               -- ms since the epoch
);
