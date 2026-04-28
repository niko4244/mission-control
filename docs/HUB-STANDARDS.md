# Hub Authority Standard

**Version**: 1.0.0
**Date**: 2026-04-26
**Status**: Active

---

## 1. Mission Control as Single Source of Truth

Mission Control (`C:\Users\nikma\mission-control`) is the authoritative hub for all state in the development environment. No other system may independently own canonical state for the domains listed below.

### Authoritative Domains

| Domain | Owner | Notes |
|--------|-------|-------|
| Agent registry | Mission Control DB (agents table) | All agents must be registered here |
| Model routes | `config/model-routes.yaml` | Hermes route definitions are deprecated |
| Task state | Mission Control DB (tasks table) | Tasks created outside MC must sync |
| Memory access | Mission Control DB + `memory/` filesystem | External stores are imports only |
| Tool permissions | Mission Control DB (settings table) | No ad-hoc permission grants |
| Cleanup workflows | Mission Control task tracks | Track-based cleanup enforced |
| GitHub sync status | Mission Control DB (git_events table, future) | Sync state tracked centrally |
| Quality gates | `.github/workflows/quality-gate.yml` | Gates defined here, not per-agent |
| Daily summaries | Mission Control standup_reports table | Single standup record per date |
| Token costs | Mission Control DB (token tables) | Per-agent cost attribution tracked |

---

## 2. System Roles

### Mission Control
- Role: Authoritative orchestration hub
- Runs: Next.js server on `localhost:3000`
- Owns: All canonical state (DB, memory files, config)
- Interfaces: REST API, MCP server (35 tools), CLI (`mc`), TUI
- Must not be bypassed for any registered state mutation

### Hermes
- Role: Execution worker, local model router, sandboxed bot launcher
- Runs: FastAPI on `localhost:8742`, adapter on `localhost:18789`
- Bots: `edgebot` (port 8801), `stockbot` (port 8802)
- Model routing: READS from `config/model-routes.yaml` (authoritative). Internal `MODEL_ROUTES` definitions in `HermesDaemon.ps1` and `hermes_cli.py` are deprecated and must not diverge from the YAML registry.
- Sandbox runners: Podman containers when available
- Memory stores: `~/.hermes/memory_store/` is an import source only; canonical store is Mission Control

### Claude Code
- Role: Human-facing interface, task initiator
- Registers tasks in Mission Control before beginning work
- Uses Mission Control MCP server for state reads/writes
- Does not own persistent state; reads from Mission Control

### Codex
- Role: Coding execution client, repo worker
- Executes tasks assigned via Mission Control queue
- Logs activity to Mission Control (token usage, run records)
- Does not own authoritative task state

### Cursor / Continue / Gemini CLI / LM Studio
- Role: Optional clients — not authoritative state owners
- May read from Mission Control APIs
- May not write state directly to any system without going through Mission Control

---

## 3. Operating Rules

### Rule 1 — No unregistered agent execution
Every agent that performs work must be registered in the Mission Control `agents` table before it executes. Registration requires: `name`, `role`, `type`, `status`, and optionally `source_path` and `config_path`.

### Rule 2 — No duplicate model route definitions
Model routes are defined once in `C:\Users\nikma\mission-control\config\model-routes.yaml`. Hermes reads this file. Route definitions in `HermesDaemon.ps1` and `hermes_cli.py` are deprecated. On each Hermes setup/patch cycle, route definitions must be loaded from the YAML, not from the PowerShell or Python files.

### Rule 3 — No hardcoded secrets
No token, API key, or password may be committed to any repository. Use:
- Environment variables (`.env` file, gitignored)
- Windows keyring via `python3 -c "import keyring; keyring.set_password(...)"`
- Mission Control settings table (encrypted at rest)

Identified hardcoded secrets in `~/.claude/settings.local.json` must be rotated and moved to env vars. See `reports/security/secrets-hardening.md`.

### Rule 4 — No untracked memory stores
External memory stores (Hermes `memory_store/`, Codex `logs_2.sqlite`, Claude Code `history.jsonl`) may exist as source files but must be imported into Mission Control's knowledge base to be searchable and authoritative. New memory entries must be written via the `mc_write_knowledge_file` MCP tool or the REST API.

### Rule 5 — No commit or push without quality gate
All commits to repositories with CI pipelines (`mission-control`, `opcode`, `open-health`) must pass quality gates before pushing. See `docs/QUALITY-GATES.md` for per-project gate definitions.

### Rule 6 — No dangerous operations without task registration
Dangerous operations (file deletion, package installation, secret modification, git push, schema migrations, shell commands outside the approved allowlist) require:
1. An active Mission Control task ID
2. A stated reason
3. A documented rollback plan
4. Post-operation verification check

---

## 4. CLI Access

The `mc` CLI is the primary interface for scripted hub operations:

```bash
pnpm mc <group> <action> [--flags]
```

Available from the mission-control directory. Also callable as:
```bash
node /path/to/mission-control/scripts/mc-cli.cjs <group> <action>
```

### Planned alias: `foundry`
A global shell alias `foundry` pointing to `mc` is planned to provide a consistent entry point across terminals. Until implemented, use `pnpm mc` from the mission-control directory or the full node path.

To add the alias manually:
```bash
# In .bashrc or .zshrc:
alias foundry="node C:/Users/nikma/mission-control/scripts/mc-cli.cjs"
```

---

## 5. Deprecation Notices

| File | Deprecated Feature | Replacement |
|------|--------------------|-------------|
| `~/.hermes/HermesDaemon.ps1` lines 40-48 | `$MODEL_ROUTES` hashtable | `mission-control/config/model-routes.yaml` |
| `~/.hermes/hermes_cli.py` lines 29-37 | `MODEL_ROUTES` dict | `mission-control/config/model-routes.yaml` |
| `~/.claude/settings.local.json` | Hardcoded bearer tokens | Env vars + keyring |

---

## 6. Change History

| Date | Change | Author |
|------|--------|--------|
| 2026-04-26 | Initial hub standards document created | Hub consolidation phase 1 |
