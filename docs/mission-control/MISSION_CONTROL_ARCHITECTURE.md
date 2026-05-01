# Mission Control Architecture v1

**Version**: 1.0.0
**Date**: 2026-05-01
**Status**: Active — first implementation target: Passive Income Bot

---

## 1. Hierarchy

```
Owner
└── Mission Control  (central orchestrator — this repo)
    └── Systems Curator  (meta-agent: quality gates, memory review, scheduling)
        ├── Passive Income Bot
        ├── Stocks / Trading Research Bot
        ├── Sports Betting Bot
        ├── Appliance Intelligence Bot
        ├── Builder / Coding Bot          ← current operator
        ├── Research Scout
        └── Content / Design Bot
```

**Owner** holds all Level 5 (Financial Risk) approvals and all production deployment approvals.

**Mission Control** is the orchestration layer — task queue, memory store, outcome tracking, review queue, skill dispatch.

**Systems Curator** runs scheduled health checks, memory review, quality gate enforcement, and bot performance audits. It does not originate domain actions.

**Domain Bots** are single-purpose agents that receive tasks, consume skills, write evidence, and return outcomes. They do not talk to each other directly — all inter-bot coordination goes through Mission Control tasks.

---

## 2. Shared Bot Interface

Every domain bot must implement:

```
INPUT:
  task_id        Mission Control task ID
  prompt         Goal statement
  risk_level     0–5 (see Risk Policy)
  memory_context Recalled patterns from memory service
  skill_manifest List of skills the bot may invoke

OUTPUT:
  status         success | failure | pending_approval
  evidence_log   Array of structured evidence entries (see Evidence Log Schema)
  outcome_id     Written back to memory via outcome tracking
  draft_output   Human-readable result (never auto-published)
  approval_gates List of gates that blocked or must be cleared
```

---

## 3. Skill Layer

Skills are discrete, executable capabilities. A bot may call a skill; a skill may not call a bot.

| Skill | Purpose | Risk ceiling |
|---|---|---|
| GitHub Skill | Read repos, open issues, create PRs (draft only) | 3 |
| Web Research Skill | Fetch and parse public web content | 1 |
| Image Generation Skill | Generate images locally or via API | 1 |
| PDF / Document Generation Skill | Render structured output to PDF | 1 |
| Package Hygiene Skill | Audit, update, test dependencies | 3 |
| Market Data Skill | Fetch price/volume data from public APIs | 1 |
| Sports Odds Skill | Fetch odds from public APIs | 1 |
| Backtesting Skill | Run strategy simulations on historical data | 2 |
| Paper Trading Skill | Simulate trades against live prices, no real orders | 2 |
| Analytics Skill | Compute metrics, run regressions, score hypotheses | 2 |
| Memory / Evidence Log Skill | Write to and recall from memory service | 1 |
| Scheduler Skill | Create/update Mission Control cron jobs | 2 |
| Local Model Skill | Invoke local Ollama/LM Studio models | 1 |

---

## 4. Data Flow

```
Owner / Bot invokes task
        ↓
Mission Control task queue
        ↓
Systems Curator routes to domain bot
        ↓
Bot recalls memory context
        ↓
Bot invokes skill(s)
        ↓
Bot writes evidence log
        ↓
Bot checks approval gates
        ↓
  [GATE CLEAR]                  [GATE BLOCKED]
       ↓                              ↓
Return draft output        Queue for Owner review (status: pending_approval)
       ↓                              ↓
Outcome written            Owner approves → bot executes → outcome written to memory
to memory                  Owner rejects  → rejection reason written to memory
```

---

## 5. Memory Integration

Every bot run that produces a learnable outcome must:

1. Call `recall` with the task prompt before executing
2. Consult recalled patterns as context (not as commands)
3. Write an evidence entry via `write` with `category='execution'`
4. Call `markOutcome` with `success | failure | unknown` after completion
5. Include `primaryPatternId` so the learning loop updates scores

Memory entries flagged by the review queue (`/api/memory/review`) are surfaced to Systems Curator for manual disposition. No bot may auto-delete memory entries.

---

## 6. Per-Bot Module Summary

See individual registry entries in `AGENT_REGISTRY.md`.

| Bot | Domain | First milestone |
|---|---|---|
| Passive Income Bot | Idea → evidence → draft plan | Phase 1 |
| Stocks / Trading Research Bot | Paper trading simulation | v2 |
| Sports Betting Bot | Paper betting simulation | v2 |
| Appliance Intelligence Bot | Fault diagnosis | v2 |
| Builder / Coding Bot | Code generation, CI | ongoing |
| Research Scout | Web scraping, literature | v2 |
| Content / Design Bot | Copywriting, image prompts | v3 |

---

## 7. Build Order

```
Phase 0 (done): Memory service, recall, audit, review queue, outcome tracking
Phase 1 (now):  Passive Income Bot — architecture + evidence loop
Phase 2:        Stocks Bot + Sports Betting Bot (paper only)
Phase 3:        Appliance Bot + Research Scout
Phase 4:        Content Bot + Scheduler automation
Phase 5:        Skill publish/search (community layer)
```

---

## 8. Constraints

- No real-money transactions at any phase without Owner explicit approval
- No auto-publishing of any content
- No auto-betting or auto-trading
- No live brokerage or bookmaker API connections in v1 or v2
- All external API keys stored in `.env`, never committed
- All bot outputs are drafts until Owner marks them approved
