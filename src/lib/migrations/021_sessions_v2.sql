-- Migration 021: Create sessions_v2 table
-- Date: 2026-04-27
-- Description: Create sessions_v2 table for cross-agent session tracking
-- Golden Rule: COPY-ONLY migration - no deletes

CREATE TABLE IF NOT EXISTS sessions_v2 (
    id TEXT PRIMARY KEY,
    agent_id INTEGER NOT NULL,
    project TEXT,
    branch TEXT,
    started_at INTEGER NOT NULL DEFAULT (unixepoch()),
    ended_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    -- Values: active, paused, completed, failed, abandoned
    summary TEXT,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_v2_agent_id ON sessions_v2(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_v2_status ON sessions_v2(status);
CREATE INDEX IF NOT EXISTS idx_sessions_v2_started_at ON sessions_v2(started_at);