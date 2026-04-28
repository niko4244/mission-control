# Memory Schema Design

**Version**: 1.0.0
**Date**: 2026-04-26
**Status**: Design document — tables marked NEW require a future migration

---

## 1. Existing Schema (as of 2026-04-26)

The following tables are defined in `src/lib/schema.sql` and managed via `src/lib/migrations.ts`:

| Table | Migration | Purpose |
|-------|-----------|---------|
| `tasks` | 001_init | Core Kanban task management |
| `agents` | 001_init | Agent registry |
| `comments` | 001_init | Task discussion threads |
| `activities` | 001_init | Real-time activity stream |
| `notifications` | 001_init | @mentions and alerts |
| `task_subscriptions` | 001_init | Who follows which tasks |
| `standup_reports` | 001_init | Daily standup archive |
| `quality_reviews` | 002_quality_reviews | Aegis quality gate records |
| `messages` | 004_messages | Agent-to-agent messaging |
| `users` | 005_users | Human user accounts |
| `user_sessions` | 005_users | Auth session tokens |
| `workflow_templates` | 006_workflow_templates | Reusable task templates |
| `audit_log` | 007_audit_log | Action audit trail |
| `webhooks` | 008_webhooks | Outbound webhook config |
| `webhook_deliveries` | 008_webhooks | Webhook delivery records |
| `workflow_pipelines` | 009_pipelines | Multi-step pipeline definitions |
| `pipeline_runs` | 009_pipelines | Pipeline execution records |
| `settings` | 010_settings | Key-value settings store |
| `alert_rules` | 011_alert_rules | Automated alert conditions |
| `tenants` | 012_super_admin_tenants | Multi-tenant support (super admin) |
| `gateway_health_logs` | 001_init | Gateway probe history |
| `token_usage` (via adapters) | (runtime) | Per-agent token cost tracking |

---

## 2. Shared Memory Layer — New Table Designs

These tables do NOT exist yet. They represent the target design for the cross-agent shared memory layer. They must be implemented as new numbered migrations in `src/lib/migrations.ts`, never by modifying the existing schema.

**Golden rule**: First migration is copy-only. Do not delete original memory stores.

---

### 2.1 agents (EXTEND existing)

The existing `agents` table covers most fields. The following columns are missing and should be added via ALTER TABLE in a new migration:

```sql
-- Add to existing agents table (new migration only):
ALTER TABLE agents ADD COLUMN type TEXT DEFAULT 'unknown';
-- Values: claude-code, codex, hermes-bot, gemini-cli, cursor, lmstudio, custom

ALTER TABLE agents ADD COLUMN provider TEXT DEFAULT 'local';
-- Values: anthropic, openai, google, ollama, local, custom

ALTER TABLE agents ADD COLUMN source_path TEXT;
-- Filesystem path to the agent's main script or entrypoint

ALTER TABLE agents ADD COLUMN config_path TEXT;
-- Path to the agent's config file (if any)
```

Current existing columns: `id`, `name`, `role`, `session_key`, `soul_content`, `status`, `last_seen`, `last_activity`, `created_at`, `updated_at`, `config`

---

### 2.2 sessions (NEW)

```sql
CREATE TABLE IF NOT EXISTS sessions_v2 (
    id TEXT PRIMARY KEY,                -- UUID or nanoid
    agent_id INTEGER NOT NULL,          -- FK to agents.id
    project TEXT,                       -- project slug/path
    branch TEXT,                        -- git branch (if applicable)
    started_at INTEGER NOT NULL DEFAULT (unixepoch()),
    ended_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    -- Values: active, paused, completed, failed, abandoned
    summary TEXT,                       -- AI-generated or manual session summary
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_v2_agent_id ON sessions_v2(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_v2_status ON sessions_v2(status);
CREATE INDEX IF NOT EXISTS idx_sessions_v2_started_at ON sessions_v2(started_at);
```

Note: The existing `sessions`-related tables in mission-control track Claude Code / Codex /  Hermes sessions at the runtime level. `sessions_v2` is the canonical cross-agent session record.

---

### 2.3 tasks (existing — document current schema)

Existing schema already covers most fields. Missing fields for the target design:

```sql
-- Add to existing tasks table (new migration):
ALTER TABLE tasks ADD COLUMN session_id TEXT;
-- FK to sessions_v2.id

ALTER TABLE tasks ADD COLUMN track TEXT DEFAULT 'general';
-- Cleanup tracks: memory, auth, security, tooling, ci, general

ALTER TABLE tasks ADD COLUMN risk_level TEXT DEFAULT 'low';
-- Values: none, low, medium, high, critical

ALTER TABLE tasks ADD COLUMN confidence REAL DEFAULT 1.0;
-- 0.0-1.0, machine-assigned confidence score
```

---

### 2.4 memory_entries (NEW)

```sql
CREATE TABLE IF NOT EXISTS memory_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    -- Values: hermes, codex, claude-code, gemini, manual, import
    source_ref TEXT,
    -- Original file path, history entry ID, or external ref
    project TEXT,                       -- Project slug/path this entry belongs to
    category TEXT NOT NULL DEFAULT 'general',
    -- Values: decision, lesson, context, error, pattern, fact, general
    content TEXT NOT NULL,              -- The memory content (markdown)
    confidence REAL DEFAULT 1.0,        -- 0.0-1.0
    tags TEXT DEFAULT '[]',             -- JSON array of tags
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_memory_entries_source ON memory_entries(source);
CREATE INDEX IF NOT EXISTS idx_memory_entries_category ON memory_entries(category);
CREATE INDEX IF NOT EXISTS idx_memory_entries_project ON memory_entries(project);
CREATE INDEX IF NOT EXISTS idx_memory_entries_created_at ON memory_entries(created_at);

-- FTS5 full-text search index (built separately via rebuild endpoint)
CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
    content, tags,
    content='memory_entries',
    content_rowid='id'
);
```

---

### 2.5 decisions (NEW)

```sql
CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,                    -- FK to tasks.id (nullable)
    title TEXT NOT NULL,
    decision TEXT NOT NULL,             -- The decision made
    rationale TEXT,                     -- Why this decision was made
    alternatives_considered TEXT,       -- JSON array of alternatives
    risk TEXT DEFAULT 'low',
    -- Values: none, low, medium, high
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_task_id ON decisions(task_id);
CREATE INDEX IF NOT EXISTS idx_decisions_created_at ON decisions(created_at);
```

---

### 2.6 checks (NEW)

```sql
CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,                    -- FK to tasks.id (nullable)
    command TEXT NOT NULL,              -- The check command run
    status TEXT NOT NULL DEFAULT 'pending',
    -- Values: pending, running, passed, failed, skipped
    output_summary TEXT,                -- Truncated first 500 chars of output
    started_at INTEGER DEFAULT (unixepoch()),
    completed_at INTEGER,
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_checks_task_id ON checks(task_id);
CREATE INDEX IF NOT EXISTS idx_checks_status ON checks(status);
```

---

### 2.7 git_events (NEW)

```sql
CREATE TABLE IF NOT EXISTS git_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,                    -- FK to tasks.id (nullable)
    repo TEXT NOT NULL,                 -- Repository path or URL
    branch TEXT NOT NULL,
    commit_hash TEXT,                   -- SHA of the commit (if applicable)
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
```

---

### 2.8 risks (NEW)

```sql
CREATE TABLE IF NOT EXISTS risks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER,                    -- FK to tasks.id (nullable)
    severity TEXT NOT NULL DEFAULT 'low',
    -- Values: info, low, medium, high, critical
    description TEXT NOT NULL,
    mitigation TEXT,                    -- Planned or applied mitigation
    status TEXT NOT NULL DEFAULT 'open',
    -- Values: open, mitigated, accepted, dismissed
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_risks_task_id ON risks(task_id);
CREATE INDEX IF NOT EXISTS idx_risks_severity ON risks(severity);
CREATE INDEX IF NOT EXISTS idx_risks_status ON risks(status);
```

---

## 3. Migration Strategy

### Principles
1. Mission Control DB is authoritative. External memory files exist only as imports/exports.
2. First migration touching any existing table must be copy-only (read existing data, write to new columns or tables — no deletes).
3. Do not delete original memory stores (`~/.hermes/memory_store/`, `~/.codex/logs_2.sqlite`, `~/.claude/history.jsonl`). These remain as source-of-truth backups until explicitly migrated and verified.
4. Each new table gets its own numbered migration ID in `migrations.ts`.

### Recommended migration sequence
1. `020_agents_extend` — Add `type`, `provider`, `source_path`, `config_path` columns to agents
2. `021_sessions_v2` — Create `sessions_v2` table
3. `022_tasks_extend` — Add `session_id`, `track`, `risk_level`, `confidence` to tasks
4. `023_memory_entries` — Create `memory_entries` table + FTS index
5. `024_decisions` — Create `decisions` table
6. `025_checks` — Create `checks` table
7. `026_git_events` — Create `git_events` table
8. `027_risks` — Create `risks` table

### Import plan (future)
After tables are created, write import scripts to pull from:
- `~/.hermes/memory_store/*.json` → `memory_entries` (source='hermes')
- `~/.claude/projects/*/memory/*.md` → `memory_entries` (source='claude-code')
- Mission Control knowledge base files → already accessible via existing `mc_search_knowledge` / `mc_read_knowledge_file` tools

---

## 4. External Memory Stores (current state)

| Store | Location | Size | Format | Status |
|-------|----------|------|--------|--------|
| Hermes memory | `~/.hermes/memory_store/` | unknown | SQLite + JSON | Import source |
| Hermes knowledge | `~/.hermes/knowledge/` | unknown | Milvus vectors | Import source (future) |
| Claude Code history | `~/.claude/history.jsonl` | 143KB | JSONL | Import source |
| Codex state | `~/.codex/.codex-global-state.json` | 47KB | JSON | Import source |
| Codex logs | `~/.codex/logs_2.sqlite` | 82MB | SQLite | Import source |
| MC knowledge base | `~/.mission-control/memory/` | varies | Markdown | Authoritative |
| MC DB | `mission-control/.data/mission-control.db` | varies | SQLite | Authoritative |
