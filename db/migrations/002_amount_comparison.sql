-- PTB automatic screenshot amount checker migration.
-- Adds the outcome of the automatic claimed-vs-screenshot amount comparison
-- (MATCH, MISMATCH, or NEEDS_REVIEW) to the existing treasury record.
-- Applied automatically at startup by src/treasury-ops.js
-- (ALTER TABLE, tolerant of the column already existing), or manually on
-- Bothost.net before restarting the bot.
ALTER TABLE treasury_submissions ADD COLUMN amount_comparison TEXT;
