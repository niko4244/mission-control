# Quality Gates

**Version**: 1.0.0
**Date**: 2026-04-27
**Status**: Active

---

## 1. Overview

Quality gates ensure consistent code quality across all projects in the development environment. Each project has specific checks that must pass before code can be merged or deployed.

---

## 2. Project-Specific Gates

### 2.1 mission-control

| Check | Command | Fail Behavior |
|-------|---------|---------------|
| API contract parity | `pnpm api:parity` | Block merge |
| Lint | `pnpm lint` | Block merge |
| Typecheck | `pnpm typecheck` | Block merge |
| Unit tests | `pnpm test` | Block merge |
| Build | `pnpm build` | Block merge |
| E2E tests | `pnpm test:e2e` | Block merge |

**Current Status**: ALL CHECKS ACTIVE

**Quality Gate Workflow**: `.github/workflows/quality-gate.yml`

### 2.2 Hermes

| Check | Command | Fail Behavior |
|-------|---------|---------------|
| Python syntax | `python -m py_compile *.py` | Block run |
| Lint (ruff) | `ruff check .` | Report only |
| Python typecheck | `mypy` (if feasible) | Report only |

**Current Status**: PARTIAL - syntax check required, others report-only

### 2.3 Hermes Studio

| Check | Command | Fail Behavior |
|-------|---------|---------------|
| TypeScript compile | `tsc --noEmit` | Block build |
| ESLint | `eslint .` | Report only |

**Current Status**: PARTIAL

### 2.4 Opcode (future)

| Check | Command | Fail Behavior |
|-------|---------|---------------|
| Rust compile | `cargo check` | Block |
| Clippy | `cargo clippy` | Report only |
| Tests | `cargo test` | Block |

**Status**: Not yet implemented

### 2.5 open-health (future)

| Check | Command | Fail Behavior |
|-------|---------|---------------|
| Python syntax | `python -m py_compile` | Block |
| Lint (ruff) | `ruff check .` | Report only |
| Tests | `pytest` | Block |

**Status**: Not yet implemented

### 2.6 Gemini-CLI-UI

| Check | Command | Fail Behavior |
|-------|---------|---------------|
| TypeScript compile | `tsc --noEmit` | Block build |
| ESLint | `eslint .` | Report only |

**Current Status**: PARTIAL

---

## 3. Gate Mode Options

### 3.1 Strict Mode (Default for mission-control)
- All checks must pass
- No bypass allowed
- CI enforces gates

### 3.2 Report-Only Mode
- Checks run but failures are logged
- No blocking occurs
- Use when migrating legacy code
- Enable via: `GATE_MODE=report-only`

### 3.3 Disabled Mode
- No checks run
- NEVER use in production
- Enable via: `GATE_MODE=disabled`

---

## 4. Running Gates Locally

### 4.1 Full Quality Gate
```bash
pnpm quality:gate
```

### 4.2 Individual Checks
```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

### 4.3 Report-Only Mode
```bash
GATE_MODE=report-only pnpm lint
```

---

## 5. CI Integration

### 5.1 GitHub Actions
Quality gates run automatically on:
- Pull requests
- Push to main branch

### 5.2 Pre-commit Hook
To add pre-commit hooks (verify before enabling):
```bash
# Enable after confirming gates pass locally
npx husky init
```

**Note**: Pre-commit is NOT enabled by default. Enable only after verifying all gates pass in your local environment.

---

## 6. Troubleshooting

### 6.1 Pre-existing Failures
If gates fail on legacy code:
1. Run with `GATE_MODE=report-only`
2. Create issues for each failure category
3. Fix incrementally in dedicated PRs

### 6.2 New Project Setup
For new projects, start with:
1. **Phase 1**: Syntax check only (strict)
2. **Phase 2**: Add lint (report-only)
3. **Phase 3**: Add typecheck (report-only)
4. **Phase 4**: Enable full strict mode

---

## 7. Change History

| Date | Change | Author |
|------|--------|--------|
| 2026-04-27 | Initial quality gates document | Hub consolidation phase 6 |