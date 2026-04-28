-- Migration 024: Create decisions table
-- Date: 2026-04-27
-- Description: Create decisions table for architectural decision tracking
-- Golden Rule: COPY-ONLY migration - no deletes

CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    -- FK to tasks.id (nullable)
    title TEXT NOT NULL,
    decision TEXT NOT NULL,
    -- The decision made
    rationale TEXT,
    -- Why this decision was made
    alternatives_considered TEXT,
    -- JSON array of alternatives
    risk TEXT DEFAULT 'low',
    -- Values: none, low, medium, high
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_task_id ON decisions(task_id);
CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);