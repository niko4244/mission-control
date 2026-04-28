-- Migration 027: Create risks table
-- Date: 2026-04-27
-- Description: Create risks table for unresolved risk tracking
-- Golden Rule: COPY-ONLY migration - no deletes

CREATE TABLE IF NOT EXISTS risks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    -- FK to tasks.id (nullable)
    severity TEXT NOT NULL DEFAULT 'low',
    -- Values: info, low, medium, high, critical
    description TEXT NOT NULL,
    mitigation TEXT,
    -- Planned or applied mitigation
    status TEXT NOT NULL DEFAULT 'open',
    -- Values: open, mitigated, accepted, dismissed
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_risks_task_id ON risks(task_id);
CREATE INDEX IF NOT EXISTS idx_risks_severity ON risks(severity);
CREATE INDEX IF NOT EXISTS idx_risks_status ON risks(status);