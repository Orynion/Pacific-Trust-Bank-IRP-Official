-- PTB IRP Treasury screenshot-assisted verification schema.
-- Applied automatically at startup by src/treasury-ops.js.
CREATE TABLE IF NOT EXISTS treasury_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT UNIQUE,
  submitter_id TEXT NOT NULL,
  payer_username TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount > 0),
  purpose TEXT NOT NULL,
  attachment_url TEXT NOT NULL,
  attachment_name TEXT NOT NULL,
  screenshot_hash TEXT NOT NULL,
  perceptual_hash TEXT,
  ocr_text TEXT NOT NULL DEFAULT '',
  extracted_payer TEXT,
  extracted_recipient TEXT,
  extracted_amount INTEGER,
  transaction_id TEXT,
  findings TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK(status IN ('PENDING','NEEDS_REVIEW','VERIFIED','REJECTED','DUPLICATE')),
  reviewer_id TEXT,
  review_reason TEXT,
  duplicate_of TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_treasury_screenshot_hash ON treasury_submissions(screenshot_hash);
CREATE INDEX IF NOT EXISTS idx_treasury_submitter ON treasury_submissions(submitter_id, created_at);
CREATE INDEX IF NOT EXISTS idx_treasury_status ON treasury_submissions(status, created_at);
CREATE TABLE IF NOT EXISTS treasury_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER IF NOT EXISTS treasury_audit_no_update BEFORE UPDATE ON treasury_audit_log BEGIN SELECT RAISE(ABORT, 'treasury audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS treasury_audit_no_delete BEFORE DELETE ON treasury_audit_log BEGIN SELECT RAISE(ABORT, 'treasury audit log is append-only'); END;
CREATE TABLE IF NOT EXISTS treasury_ticket_receipt_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  submitted_by TEXT NOT NULL,
  screenshot_hash TEXT NOT NULL,
  perceptual_hash TEXT,
  attachment_url TEXT NOT NULL,
  ocr_text TEXT NOT NULL DEFAULT '',
  extracted_payer TEXT,
  extracted_recipient TEXT,
  extracted_amount INTEGER,
  findings TEXT NOT NULL DEFAULT '[]',
  duplicate_reference TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_treasury_ticket_hash ON treasury_ticket_receipt_checks(screenshot_hash);
CREATE INDEX IF NOT EXISTS idx_treasury_ticket_id ON treasury_ticket_receipt_checks(ticket_id, created_at);
