# Schedules

**Version**: 1.0.0
**Date**: 2026-05-01
**Status**: Planned — no cron jobs active until Phase 1 is complete

All recurring jobs run through Mission Control's cron system (`mc cron`). Schedules are not activated until the Systems Curator approves them and the risk level has been cleared.

---

## Schedule Registry

### Systems Curator — Memory Review
| Field | Value |
|---|---|
| Job name | `memory-review-weekly` |
| Bot | Systems Curator |
| Schedule | `0 9 * * 1` (Monday 09:00 UTC) |
| Action | Call `GET /api/memory/review`, surface flagged entries to Owner via notification |
| Risk level | 0 (observe) |
| Status | PLANNED |
| Notes | Auto-dismisses entries with `warnings.length === 0`; escalates `high_risk` count > 5 |

### Systems Curator — Bot Health Check
| Field | Value |
|---|---|
| Job name | `bot-health-daily` |
| Bot | Systems Curator |
| Schedule | `0 8 * * *` (daily 08:00 UTC) |
| Action | Check all agent heartbeats; alert if any bot has not run in 7 days |
| Risk level | 0 (observe) |
| Status | PLANNED |

### Passive Income Bot — Niche Scan
| Field | Value |
|---|---|
| Job name | `passive-income-niche-scan` |
| Bot | Passive Income Bot |
| Schedule | `0 10 * * 3` (Wednesday 10:00 UTC) |
| Action | Research 3 niche opportunities; write evidence log; produce draft brief |
| Risk level | 1 (draft) |
| Status | PLANNED — activates after Phase 1 implementation |
| Output | Draft brief to Owner inbox; no auto-publish |

### Stocks Research Bot — Paper Portfolio Update
| Field | Value |
|---|---|
| Job name | `stocks-paper-portfolio-update` |
| Bot | Stocks / Trading Research Bot |
| Schedule | `30 21 * * 1-5` (weekdays 21:30 UTC, after US close) |
| Action | Pull close prices; update simulated P&L; write evidence log |
| Risk level | 2 (test/simulation) |
| Status | PLANNED — activates after Phase 2 |
| Output | Daily P&L summary; weekly report to Owner on Fridays |

### Sports Betting Bot — Pre-Game Odds Scan
| Field | Value |
|---|---|
| Job name | `sports-odds-pregame-scan` |
| Bot | Sports Betting Bot |
| Schedule | `0 12 * * *` (daily 12:00 UTC) |
| Action | Fetch next 24h odds; compute edge scores; log paper bet candidates |
| Risk level | 2 (test/simulation) |
| Status | PLANNED — activates after Phase 2 |
| Output | Edge report; no auto-betting |

### Builder Bot — Dependency Audit
| Field | Value |
|---|---|
| Job name | `dependency-audit-weekly` |
| Bot | Builder / Coding Bot |
| Schedule | `0 11 * * 5` (Friday 11:00 UTC) |
| Action | Run `pnpm audit`; list outdated; open draft PR for patch-level upgrades |
| Risk level | 3 (controlled action — draft PR only) |
| Status | PLANNED |
| Approval | Major version upgrades require Owner approval before PR is promoted |

---

## Cron Management

Create a job:
```bash
mc cron create --name <job-name> --schedule "<cron>" --agent <agent-name> --task-template <template>
```

Pause a job:
```bash
mc cron pause --name <job-name>
```

List all jobs:
```bash
mc cron list --json
```

All cron jobs are stored in the Mission Control database. They do not depend on external cron infrastructure.

---

## Notes

- No schedule activates automatically. Owner or Systems Curator must enable it explicitly.
- Schedules are paused during Owner-declared freezes.
- All scheduled outputs land in Mission Control tasks as drafts before any action occurs.
- Financial-risk schedules (Level 5) do not exist. Real-money actions are always Owner-initiated.
