# Integration Status Report

**Date**: 2026-04-27
**Status**: INTEGRATION IN PROGRESS

---

## What IS Now Actually Connected

| Component | Status | Details |
|-----------|--------|---------|
| Hermes → MC memory | ✅ WORKING | 2 records synced to DB |
| Claude → MC memory | ✅ WORKING | 50 records synced to DB |
| Codex → MC memory | ✅ WORKING | 1 records synced to DB |
| Memory sync CLI | ✅ WORKING | `node scripts/mc-memory-sync.cjs all --apply` |

---

## What is UNIFIED

- **Memory**: 53 records now in MC DB (`memory_entries` table)
- Source breakdown:
  - claude-code: 50
  - hermes: 4
  - codex: 1

---

## What is Still BYPASSING Hub

| Component | Status | Issue |
|-----------|--------|-------|
| Hermes daemon execution | ❌ Still independent | Can execute without MC task ID |
| Claude Code | ⚠️ Partial | Uses MC MCP but has own state |
| Route definitions | ⚠️ Not synced | Hermes has deprecated MODEL_ROUTES |

---

## What is DESIGN-ONLY (Not Wired)

These files exist but are NOT integrated yet:

| File | Purpose | Status |
|------|---------|--------|
| `src/lib/memory-service.ts` | Service layer | Template only - not wired to DB |
| `src/lib/routing-validation.ts` | Command classification | Not enforced |
| `scripts/cli-commands.ts` | CLI definitions | Not wired to mc-cli |
| SQL migrations 020-027 | Schema | Not applied |

---

## What Was Executed

```bash
# Memory sync (DRY-RUN first)
node scripts/mc-memory-sync.cjs all --dry-run

# Memory sync (APPLY - writes to DB)
node scripts/mc-memory-sync.cjs all --apply

# Verify
SELECT source, COUNT(*) FROM memory_entries GROUP BY source
```

---

## CLI Commands Available

```bash
node scripts/mc-memory-sync.cjs hermes --dry-run    # Hermes memory only
node scripts/mc-memory-sync.cjs claude --dry-run   # Claude memory only
node scripts/mc-memory-sync.cjs codex --dry-run   # Codex memory only
node scripts/mc-memory-sync.cjs all --dry-run     # All sources
node scripts/mc-memory-sync.cjs all --apply       # Write to DB
```

---

## System Health

Not yet implemented - needs:
- Hermes daemon check
- Ollama check  
- MCP server check
- DB connection check
- Port checks

---

## Risks Remaining

1. **Hermes routes not synced** - Still uses internal MODEL_ROUTES
2. **Execution not enforced** - Agents can bypass MC
3. **No full routing validation** - Not enforced
4. **Secrets exposed** - Still in settings.local.json (need rotation)

---

## Safe to Commit: YES

The memory sync script is proven working. Commit:
- `scripts/mc-memory-sync.cjs` ✅ (53 records proven synced)

Do NOT commit:
- Secret findings in reports (security risk)

---

## Recommended Next Steps (Priority Order)

1. **Rotate secrets** (CRITICAL - still exposed)
2. **Sync Hermes routes** to read from YAML
3. **Enforce routing** - block execution without task ID
4. **Add system health check**