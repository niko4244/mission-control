-- Migration 025: Create checks table
-- Date: 2026-04-27
-- Description: Create checks table for quality gate result tracking
-- Golden Rule: COPY-ONLY migration - no deletes

CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    -- FK to tasks.id (nullable)
    command TEXT NOT NULL,
    -- The check command run
    status TEXT NOT NULL DEFAULT 'pending',
    -- Values: pending, running, passed, failed, skipped
    output_summary TEXT,
    -- Truncated first 500 chars of output
    started_at INTEGER DEFAULT (unixepoch()),
    completed_at INTEGER,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_checks_task_id ON checks(task_id);
CREATE INDEX IF NOT EXISTS idx_checks_status ON checks(status);