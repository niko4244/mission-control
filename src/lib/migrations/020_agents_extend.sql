-- Migration 020: Extend agents table
-- Date: 2026-04-27
-- Description: Add type, provider, source_path, config_path columns to agents table
-- Golden Rule: ADDITIVE ONLY - no data deletion

ALTER TABLE agents ADD COLUMN type TEXT DEFAULT 'unknown';
-- Values: claude-code, codex, hermes-bot, gemini-cli, cursor, lmstudio, custom

ALTER TABLE agents ADD COLUMN provider TEXT DEFAULT 'local';
-- Values: anthropic, openai, google, ollama, local, custom

ALTER TABLE agents ADD COLUMN source_path TEXT;
-- Filesystem path to the agent's main script or entrypoint

ALTER TABLE agents ADD COLUMN config_path TEXT;
-- Path to the agent's config file (if any)