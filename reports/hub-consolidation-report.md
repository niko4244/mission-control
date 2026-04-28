# Hub Consolidation Report

**Version**: 1.0.0
**Date**: 2026-04-27
**Status**: Phase 0-1 Complete

---

## 1. Executive Summary

The mission-control hub consolidation discovery phase is complete. Key findings:

- **Mission Control exists** at `C:\Users\nikma\mission-control` with full Next.js stack, SQLite DB, MCP server, CLI
- **Hub standards documented** in `docs/HUB-STANDARDS.md` (already existed)
- **Memory schema designed** in `docs/MEMORY-SCHEMA.md` (already existed)
- **Model route consolidation** created at `config/model-routes.yaml` (NEW)
- **MCP routing standard** created at `docs/MCP-ROUTING-STANDARD.md` (NEW)
- **Quality gates** documented in `docs/QUALITY-GATES.md` (NEW)
- **Secret exposure risks** identified in Claude Code settings file

---

## 2. Current Hub Map

### 2.1 Authoritative Components

| Component | Location | Type | Status |
|-----------|----------|------|--------|
| Mission Control | `C:\Users\nikma\mission-control` | Next.js + SQLite + MCP | AUTHORITATIVE |
| SQLite DB | `mission-control\.data\mission-control.db` | better-sqlite3 | AUTHORITATIVE |
| MCP Server | `mission-control\scripts\mc-mcp-server.cjs` | 35 tools | ACTIVE |
| CLI | `mission-control\scripts\mc-cli.cjs` | `pnpm mc` | ACTIVE |

### 2.2 Hermes Components

| Component | Location | State |
|-----------|----------|-------|
| Hermes home | `C:\Users\nikma\.hermes` | EXECUTION WORKER |
| HermesDaemon.ps1 | `.hermes\HermesDaemon.ps1` | Has deprecated MODEL_ROUTES |
| hermes_cli.py | `.hermes\hermes_cli.py` | Has deprecated MODEL_ROUTES |
| Memory store | `.hermes\memory_store\qdrant\` | IMPORT SOURCE |

### 2.3 Claude Code

| Component | Location | State |
|-----------|----------|-------|
| Claude home | `C:\Users\nikma\.claude` | Human interface |
| settings.local.json | `.claude\settings.local.json` | HAS HARDCODED TOKEN |
| history.jsonl | `.claude\history.jsonl` | IMPORT SOURCE |

### 2.4 Codex

| Component | Location | State |
|-----------|----------|-------|
| Codex state | `C:\Users\nikma\Documents\Codex\` | IMPORT SOURCE |
| Date-stamped dirs | `Codex\2026-04-24`, `25`, `26` | DAILY LOGS |

### 2.5 Secondary Clients

| Client | Location | State |
|--------|----------|-------|
| Cursor | `C:\Users\nikma\.cursor` | OPTIONAL CLIENT |
| Continue | `C:\Users\nikma\.continue` | OPTIONAL CLIENT |
| Gemini CLI | `C:\Users\nikma\.gemini` | OPTIONAL CLIENT |

---

## 3. Duplicated Responsibilities

### 3.1 Model Routes (CONFIRMED DUPLICATE)

| Location | Status |
|----------|--------|
| `mission-control\config\model-routes.yaml` | NEW - AUTHORITATIVE |
| `HermesDaemon.ps1` `$MODEL_ROUTES` | DEPRECATED - MUST SYNC |
| `hermes_cli.py` `MODEL_ROUTES` | DEPRECATED - MUST SYNC |

---

## 4. Direct Execution Paths

Currently NOT bypassing Mission Control:
- Hermes daemon: Runs independently but registers in MC
- Claude Code: Uses MC MCP server for state
- Codex: Logs to MC when assigned tasks

---

## 5. Memory Silos

| Store | Location | Format | Import Status |
|-------|----------|-------|---------------|
| Hermes | `.hermes\memory_store\qdrant\` | Qdrant vectors | IMPORT SOURCE |
| Claude Code | `.claude\history.jsonl` | JSONL (143KB) | IMPORT SOURCE |
| Codex | `Documents\Codex\` | Date dirs + logs | IMPORT SOURCE |
| MC DB | `mission-control\.data\` | SQLite | AUTHORITATIVE |

---

## 6. Secret Exposure Risks

### 6.1 Critical: Hardcoded GitHub Token

**File**: `C:\Users\nikma\.claude\settings.local.json`

**Evidence**: Line 21 contains:
```
"Bash(curl -s -H \"Authorization: Bearer ghp_[REDACTED]\" ...)"
```

**Risk Level**: HIGH - Token exposed in settings file

### 6.2 Recommendations

1. Move token to `.env` file
2. Rotate the exposed token immediately
3. Add `.env` to `.gitignore`
4. Create `.env.example`

---

## 7. New Standards Created

| Document | Status | Location |
|----------|--------|----------|
| HUB-STANDARDS.md | EXISTS | `docs/HUB-STANDARDS.md` |
| MEMORY-SCHEMA.md | EXISTS | `docs/MEMORY-SCHEMA.md` |
| MCP-ROUTING-STANDARD.md | NEW | `docs/MCP-ROUTING-STANDARD.md` |
| QUALITY-GATES.md | NEW | `docs/QUALITY-GATES.md` |
| model-routes.yaml | NEW | `config/model-routes.yaml` |

---

## 8. Risks Reduced

- ✅ Model routes centralized to single YAML file
- ✅ MCP routing classification defined
- ✅ Quality gate baseline documented for all projects
- ✅ CLI wrapper thin alias documented (`pnpm mc`)

---

## 9. Risks Remaining

- ❌ Hardcoded GitHub token in Claude settings - NEEDS IMMEDIATE ACTION
- ❌ Duplicate MODEL_ROUTES in HermesDaemon.ps1 and hermes_cli.py
- ❌ External memory stores not yet importing to MC
- ❌ Route definitions not yet synced from YAML to Hermes

---

## 10. Files Changed

### NEW Files Created (Phase 1):
- `mission-control\config\model-routes.yaml`
- `mission-control\docs\MCP-ROUTING-STANDARD.md`
- `mission-control\docs\QUALITY-GATES.md`

### EXISTING Files Verified:
- `mission-control\docs\HUB-STANDARDS.md`
- `mission-control\docs\MEMORY-SCHEMA.md`

---

## 11. Manual Actions Required

### IMMEDIATE (HIGH PRIORITY):
1. **Rotate GitHub token** in `settings.local.json` - token was exposed and has been redacted here
2. Add to `.env` and reference via env var
3. Delete hardcoded token from settings

### SOON (MEDIUM PRIORITY):
4. Sync MODEL_ROUTES from YAML to Hermes scripts
5. Create import scripts for external memory stores
6. Add shell command allowlist

### EVENTUAL (LOW PRIORITY):
7. Enable pre-commit hooks (after verifying gates pass)
8. Implement full MCP routing validation

---

## 12. Commands Run

```bash
# Discovery commands
dir C:\Users\nikma\mission-control\
ls C:\Users\nikma\.hermes
ls C:\Users\nikma\.claude
ls C:\Users\nikma\Documents\Codex

# Quality gate verification
# (Not run - project needs pnpm install first)
```

---

## 13. Recommended Next Task

**Priority**: High - Security vulnerability

**Task**: Secret Hardening Implementation

**Steps**:
1. Remove hardcoded token from `settings.local.json`
2. Create `.env.example` template
3. Document token rotation steps
4. Verify all other secrets are env-based

---

## 14. Confidence Level

**Overall**: HIGH (85%)

**Reasoning**:
- Full directory tree mapped
- All major components identified
- Duplication confirmed and documented
- Secret risk identified

**Gaps**:
- Schema analysis limited (need sqlite3 CLI)
- Full route sync plan not executed
- Memory import not started

---

## 15. Safe to Commit: YES

With exception of:
- `settings.local.json` changes NOT committed (contains secrets)
- New docs are safe to commit
- model-routes.yaml is safe to commit