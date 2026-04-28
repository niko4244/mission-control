-- Migration 026: Create git_events table
-- Date: 2026-04-27
-- Description: Create git_events table for commit/branch/PR tracking
-- Golden Rule: COPY-ONLY migration - no deletes

CREATE TABLE IF NOT EXISTS git_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,
    -- FK to tasks.id (nullable)
    repo TEXT NOT NULL,
    -- Repository path or URL
    branch TEXT NOT NULL,
    commit_hash TEXT,
    -- SHA of the commit (if applicable)
    event_type TEXT NOT NULL,
    -- Values: commit, push, pr_open, pr_merge, pr_close, branch_create, branch_delete
    status TEXT NOT NULL DEFAULT 'pending',
    -- Values: pending, success, failed, skipped
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_git_events_task_id ON git_events(task_id);
CREATE INDEX IF NOT EXISTS idx_git_events_repo ON git_events(repo);
CREATE INDEX IF NOT EXISTS idx_git_events_created_at ON git_events(created_at);