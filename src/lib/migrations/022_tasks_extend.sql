-- Migration 022: Extend tasks table
-- Date: 2026-04-27
-- Description: Add session_id, track, risk_level, confidence columns to tasks table
-- Golden Rule: ADDITIVE ONLY - no data deletion

ALTER TABLE tasks ADD COLUMN session_id TEXT;
-- FK to sessions_v2.id

ALTER TABLE tasks ADD COLUMN track TEXT DEFAULT 'general';
-- Cleanup tracks: memory, auth, security, tooling, ci, general

ALTER TABLE tasks ADD COLUMN risk_level TEXT DEFAULT 'low';
-- Values: none, low, medium, high, critical

ALTER TABLE tasks ADD COLUMN confidence REAL DEFAULT 1.0;
-- 0.0-1.0, machine-assigned confidence score