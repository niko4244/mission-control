# PR Reviewer Bot

**Version**: 1.0.0
**Status**: ACTIVE — present in `data/mission-control/agent-registry.json` with `enabled: false`. Invoked manually via CLI. Not coordinator-orchestrated (requires `--repo` and `--pr` arguments).

---

## Overview

PR Reviewer Bot v1 is an observe-only Mission Control agent that automates PR review, validation, risk classification, and reviewer comment generation. It never merges, commits, pushes, or modifies any file.

---

## Usage

```bash
# Review a PR (produces JSON + Markdown comment)
node scripts/pr-reviewer.cjs --repo owner/repo --pr 123

# Review and print comment to stdout (or post it if gh is authenticated)
node scripts/pr-reviewer.cjs --repo owner/repo --pr 123 --post-comment

# pnpm shorthand
pnpm pr:review -- --repo owner/repo --pr 123
```

---

## Behavior

1. **Fetch PR metadata** — uses `gh pr view` if the gh CLI is available and authenticated; falls back to the GitHub public REST API (unauthenticated, 60 req/hr limit).
2. **Fetch changed files** — `gh pr view --json files` or `GET /repos/{owner}/{repo}/pulls/{number}/files`.
3. **Fetch diff** — prefers local git diff by fetching the PR base/head refs and diffing the fetched SHAs; falls back to `gh pr diff` if local git cannot resolve the diff.
4. **Classify files by risk**:
   - **High**: `scripts/`, `src/app/api/`, `package.json`, `pnpm-lock.yaml`, `data/mission-control/agent-registry.json`, auth/middleware files
   - **Medium**: `src/lib/`, YAML/Docker config
   - **Low**: `src/components/`, test files, docs
5. **Scan diff for red flags**:
   - `dynamic-execution` (critical): `eval()`, `new Function()`
   - `auth-bypass` (critical): skipAuth, isAuthenticated === false
   - `approval-bypass` (critical): skipApproval, auto-approve, skip-gate
   - `secrets-in-code` (critical): hardcoded keys/tokens/passwords
   - `filesystem-mutation` (high): `fs.unlinkSync`, `fs.rmSync`, `fs.writeFileSync`
   - `shell-execution` (high): `execSync`, `spawnSync`, `child_process`
   - `default-allow` (high): defaultAllow, allowAll
   - `network-call` (medium): fetch, axios, https.get
   - `new-dependency` (medium): new package added to package.json
   - `tests-removed` (medium): test files deleted from diff
6. **Run local validation suite**:
   - `pnpm typecheck`
   - `pnpm test --run`
   - `pnpm build`
   - `node scripts/systems-curator.cjs`
   - `node scripts/mc-coordinator.cjs`
7. **Compute verdict**: risk level 0–3, status OK/WARN/FAIL, recommendation string.
8. **Emit structured JSON** to stdout.
9. **Generate Markdown reviewer comment** (always included in `markdown_comment` field).
10. **Optionally post comment** via `--post-comment` flag:
    - If gh is authenticated: posts via `gh pr comment`
    - If gh is unavailable or unauthenticated: prints fallback to `comment_posted.reason`, comment text is in `markdown_comment`

---

## Safety Constraints

| Constraint | Value |
|---|---|
| `observe_only` | `true` |
| Merge capable | **No** — `--merge` and `--auto-merge` are refused with exit code 1 |
| Commit capable | No |
| Push capable | No |
| File mutation | None — reads only |
| Secrets in output | None — env vars are never logged |
| Auto-approve | Never |

Passing `--merge` or `--auto-merge` immediately exits 1 with a structured JSON refusal. This cannot be overridden.

---

## Output Format

```json
{
  "agent": "PR Reviewer Bot v1",
  "label": "OBSERVE ONLY",
  "status": "OK | WARN | FAIL",
  "risk_level": 0,
  "timestamp": "ISO8601",
  "pr": { "repo": "owner/repo", "number": 123 },
  "meta_source": "gh-cli | github-api | none",
  "diff_source": "local-git | gh-cli | none",
  "pr_meta": { "title": "...", "state": "open", "additions": 10, "deletions": 2, ... },
  "file_summary": {
    "total": 5,
    "files": [{ "path": "scripts/foo.cjs", "risk": "high", "category": "scripts", "strict_zone": true }],
    "high_risk_count": 1, "medium_risk_count": 2, "low_risk_count": 2
  },
  "red_flags": [
    { "flag": "dynamic-execution", "severity": "critical", "count": 1, "examples": [...] }
  ],
  "validation": {
    "passed": true,
    "skipped": false,
    "steps": [
      { "step": "typecheck", "passed": true, "duration_ms": 8000 },
      { "step": "test", "passed": true, "duration_ms": 45000 },
      { "step": "build", "passed": true, "duration_ms": 30000 },
      { "step": "systems-curator", "passed": true, "duration_ms": 2000 },
      { "step": "mc-coordinator", "passed": true, "duration_ms": 5000 }
    ]
  },
  "verdict": {
    "status": "FAIL",
    "risk_level": 2,
    "recommendation": "REVIEW — non-trivial risk, human review required",
    "reasons": ["1 high-risk file(s) modified"]
  },
  "warnings": ["..."],
  "recommended_next_actions": ["REVIEW — non-trivial risk, human review required"],
  "safety": { "observe_only": true, "merge_capable": false, "commit_capable": false, "push_capable": false },
  "markdown_comment": "## 🟡 PR Review — Mission Control Bot..."
}
```

---

## Risk Levels

| Level | Status | Trigger |
|---|---|---|
| 0 | OK | No flags, all files low/medium, validation passed |
| 1 | WARN | Informational flags only (network-call, new-dependency, tests-removed) |
| 2 | FAIL | High-severity red flags, high-risk files modified, or validation failure |
| 3 | FAIL | Critical red flags (eval, auth-bypass, approval-bypass, secrets) |

---

## Registry Entry

```json
{
  "id": "pr-reviewer-bot",
  "name": "PR Reviewer Bot",
  "status": "ACTIVE",
  "mode": "OBSERVE_ONLY",
  "enabled": false,
  "observe_only": true
}
```

`enabled: false` because the bot requires `--repo` and `--pr` arguments that the coordinator cannot supply. It is invoked manually or via CI.

---

## Known Limitations

- Public GitHub API metadata is enough to attempt local-git diff fetches, but fork-only or deleted head refs can still leave `diff_source: "none"` and trigger an incomplete blocking review.
- Validation runs the full test suite (~45s) and full build (~30s) — expect 90–120s total runtime.
- GitHub public API is rate-limited at 60 requests/hour unauthenticated.
- `--post-comment` only posts when gh is authenticated; otherwise it is a no-op (comment is always available in the JSON output).
