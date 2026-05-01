# Skill Registry

**Version**: 1.0.0
**Date**: 2026-05-01
**Status**: Authoritative — 1 of 13 domain skills is [BUILT — partial]. The remaining 12 are [PLANNED]. The two infrastructure skills (`mission-control-installer`, `mission-control-manage`) are fully built and listed at the end.

All skills follow the `skill.json` schema defined in `SKILL.md`. Skills may not call bots. Bots call skills.

---

## GitHub Skill [PLANNED]

| Field | Value |
|---|---|
| Name | `github` |
| Category | `utility` |
| Risk level | `medium` |
| Allowed operations | Read repo, open draft PR, create issue, list branches |
| Blocked operations | Merge PR, push to main, delete branch, modify CI |
| Requires approval | Yes (for any write operation) |
| Input | `{ action, repo, ref?, body? }` |
| Output | `{ status, url?, diff? }` |
| Test command | `pnpm test -- --grep github-skill` |

---

## Web Research Skill [PLANNED]

| Field | Value |
|---|---|
| Name | `web-research` |
| Category | `research` |
| Risk level | `low` |
| Allowed operations | HTTP GET, HTML parse, structured data extract |
| Blocked operations | POST with credentials, form submission, authenticated sessions |
| Requires approval | No |
| Input | `{ url, extract_schema? }` |
| Output | `{ content, structured_data?, source_url, fetched_at }` |
| Test command | `pnpm test -- --grep web-research-skill` |

---

## Image Generation Skill [PLANNED]

| Field | Value |
|---|---|
| Name | `image-gen` |
| Category | `utility` |
| Risk level | `low` |
| Allowed operations | Generate image via local model or API |
| Blocked operations | Auto-publish generated image |
| Requires approval | No (generation); Yes (publication) |
| Input | `{ prompt, model?, size? }` |
| Output | `{ image_path, model_used, prompt }` |
| Test command | `pnpm test -- --grep image-gen-skill` |

---

## PDF / Document Generation Skill [PLANNED]

| Field | Value |
|---|---|
| Name | `pdf-gen` |
| Category | `utility` |
| Risk level | `low` |
| Allowed operations | Render markdown or structured data to PDF |
| Blocked operations | Email or publish PDF |
| Requires approval | No (generation); Yes (distribution) |
| Input | `{ template, data, output_path }` |
| Output | `{ pdf_path, page_count }` |
| Test command | `pnpm test -- --grep pdf-gen-skill` |

---

## Package Hygiene Skill [PLANNED]

| Field | Value |
|---|---|
| Name | `package-hygiene` |
| Category | `coding` |
| Risk level | `medium` |
| Allowed operations | Audit deps, run outdated check, open upgrade PR (draft) |
| Blocked operations | Auto-merge upgrades, install packages without test run |
| Requires approval | Yes for major version upgrades |
| Input | `{ project_path, upgrade_type? }` |
| Output | `{ audit_report, proposed_upgrades, test_results }` |
| Test command | `pnpm test -- --grep package-hygiene-skill` |

---

## Market Data Skill [PLANNED]

| Field | Value |
|---|---|
| Name | `market-data` |
| Category | `research` |
| Risk level | `low` |
| Allowed operations | Fetch OHLCV, fundamentals, earnings from public APIs |
| Blocked operations | Submit orders, connect to brokerage, access account data |
| Requires approval | No |
| Input | `{ symbol, from_date, to_date, interval? }` |
| Output | `{ ohlcv[], source, fetched_at }` |
| Test command | `pnpm test -- --grep market-data-skill` |
| Notes | Uses free-tier public APIs only (Yahoo Finance, Alpha Vantage free tier) |

---

## Sports Odds Skill [PLANNED]

| Field | Value |
|---|---|
| Name | `sports-odds` |
| Category | `research` |
| Risk level | `low` |
| Allowed operations | Fetch odds, lines, results from public APIs |
| Blocked operations | Place bets, connect to bookmaker account |
| Requires approval | No |
| Input | `{ sport, league, from_date, to_date? }` |
| Output | `{ events[], odds[], source, fetched_at }` |
| Test command | `pnpm test -- --grep sports-odds-skill` |
| Notes | The Odds API free tier (500 req/month) |

---

## Backtesting Skill [PLANNED]

| Field | Value |
|---|---|
| Name | `backtesting` |
| Category | `research` |
| Risk level | `medium` |
| Allowed operations | Run strategy simulation on historical data |
| Blocked operations | Use simulated results to place real trades or bets |
| Requires approval | No (simulation); Yes (if results inform real action) |
| Input | `{ strategy, historical_data, params }` |
| Output | `{ equity_curve, metrics, trade_log, sharpe, max_drawdown }` |
| Test command | `pnpm test -- --grep backtesting-skill` |

---

## Paper Trading Skill [PLANNED]

| Field | Value |
|---|---|
| Name | `paper-trading` |
| Category | `research` |
| Risk level | `medium` |
| Allowed operations | Simulate buy/sell against live or delayed prices |
| Blocked operations | Submit to any live brokerage API |
| Requires approval | No (simulation); Yes (converting to real trade) |
| Input | `{ action, symbol, quantity, price_source }` |
| Output | `{ fill_price, simulated_pnl, portfolio_state }` |
| Test command | `pnpm test -- --grep paper-trading-skill` |

---

## Analytics Skill [PLANNED]

| Field | Value |
|---|---|
| Name | `analytics` |
| Category | `research` |
| Risk level | `low` |
| Allowed operations | Statistical analysis, regression, correlation, scoring |
| Blocked operations | None — read-only computation; produces no external side effects |
| Requires approval | No |
| Input | `{ data, analysis_type, params? }` |
| Output | `{ result, confidence, method, chart_data? }` |
| Test command | `pnpm test -- --grep analytics-skill` |

---

## Memory / Evidence Log Skill [BUILT — partial]

| Field | Value |
|---|---|
| Name | `memory-evidence-log` |
| Category | `memory` |
| Risk level | `low` |
| Allowed operations | recall, write, markOutcome, review |
| Blocked operations | Delete memory entries |
| Requires approval | No |
| Input | `{ action, agent, prompt?, content?, outcome?, id? }` |
| Output | `{ selected?, id?, updated? }` |
| Status | recall/write/markOutcome/review fully implemented; skill.json wrapper pending |
| Test command | `pnpm test` (covered by vitest suite) |

---

## Scheduler Skill [PLANNED]

| Field | Value |
|---|---|
| Name | `scheduler` |
| Category | `utility` |
| Risk level | `medium` |
| Allowed operations | Create/update/pause Mission Control cron jobs |
| Blocked operations | Delete running jobs without approval |
| Requires approval | Yes (creating recurring external-action jobs) |
| Input | `{ action, schedule, task_template }` |
| Output | `{ cron_id, next_run, status }` |
| Test command | `pnpm test -- --grep scheduler-skill` |

---

## Local Model Skill [PLANNED]

| Field | Value |
|---|---|
| Name | `local-model` |
| Category | `utility` |
| Risk level | `low` |
| Allowed operations | Invoke Ollama/LM Studio local inference |
| Blocked operations | Send PII or financial account data to any model |
| Requires approval | No |
| Input | `{ model, prompt, system?, temperature? }` |
| Output | `{ response, model_used, latency_ms }` |
| Notes | Model routing follows `config/model-routes.yaml` |
| Test command | `pnpm test -- --grep local-model-skill` |

---

## Skill Installation Status

```
skills/
  mission-control-installer/   [BUILT] Installs Mission Control itself
  mission-control-manage/      [BUILT] Manages MC instance
  (all domain skills above)    [PLANNED] — to be built in Phase 1–3
```

All planned skills require a `skill.json` manifest and a passing `test_command` before they may be installed into the registry.
