-- Migration 023: Create memory_entries table
-- Date: 2026-04-27
-- Description: Create memory_entries table for cross-agent knowledge sharing
-- Golden Rule: COPY-ONLY migration - no deletes

CREATE TABLE IF NOT EXISTS memory_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    -- Values: hermes, codex, claude-code, gemini, manual, import
    source_ref TEXT,
    -- Original file path, history entry ID, or external ref
    project TEXT,
    -- Project slug/path this entry belongs to
    category TEXT NOT NULL DEFAULT 'general',
    -- Values: decision, lesson, context, error, pattern, fact, general
    content TEXT NOT NULL,
    -- The memory content (markdown)
    confidence REAL DEFAULT 1.0,
    -- 0.0-1.0
    tags TEXT DEFAULT '[]',
    -- JSON array of tags
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_memory_entries_source ON memory_entries(source);
CREATE INDEX IF NOT EXISTS idx_memory_entries_category ON memory_entries(category);
CREATE INDEX IF NOT EXISTS idx_memory_entries_project ON memory_entries(project);
CREATE INDEX IF NOT EXISTS idx_memory_entries_created_at ON memory_entries(created_at);