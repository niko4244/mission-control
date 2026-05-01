# Evidence Log Schema

**Version**: 1.0.0
**Date**: 2026-05-01
**Status**: Active — enforced by the "No recommendation without evidence" policy

The evidence log is the learning record of the system. Every significant bot action or finding must produce at least one evidence entry. Entries are stored in the memory service (`memory_entries` table) and are subject to the review queue and outcome tracking.

---

## Entry Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `source` | string | yes | Bot name (e.g., `passive-income-bot`) |
| `category` | string | yes | Always `'execution'` for bot runs |
| `content` | string | yes | Human-readable description of the finding or action |
| `tags` | string | yes | Comma-separated key:value pairs (see Tags below) |
| `source_ref` | string | yes | Signal tracking string — must start with `source:<bot-name>` |
| `agent` | string | no | Agent name (mirrors source for bots) |
| `task_id` | integer | no | Mission Control task ID that triggered this entry |
| `run_id` | string | no | Unique run identifier for this bot execution |
| `confidence` | float | no | 0.0–1.0 confidence in the finding |
| `project` | string | no | Project or domain label |

---

## Tags Format

Tags are a comma-separated string of `key:value` pairs written to the `tags` column.

### Required tags

| Tag | Values | Meaning |
|---|---|---|
| `outcome:` | `success`, `failure`, `unknown` | Result of the run or finding |
| `domain:` | `appliance`, `coding`, `trading`, `sports`, `passive-income`, `research` | Domain category |

### Recommended tags

| Tag | Example values | Meaning |
|---|---|---|
| `evidence_type:` | `demand_signal`, `price_data`, `test_result`, `simulation_result`, `fault_diagnosis` | Class of evidence |
| `confidence:` | `high`, `medium`, `low` | Qualitative confidence |
| `source_quality:` | `primary`, `secondary`, `synthetic` | Data provenance |
| `validated:` | `true`, `false` | Whether finding has been independently confirmed |

---

## Content Standards

Content must describe:
1. **What was observed or done** — specific, not vague
2. **The condition or context** — when/where/under what circumstances
3. **The implication or lesson** — why this matters

### Good entry
```
Dryer thermal fuse blows repeatedly at Whirlpool WED4815EW1. Root cause:
cycling thermostat stuck closed (reads 0Ω at room temp, should read open).
Fix: replace cycling thermostat (part 279973). Confirmed by testing: fuse
held for 10 cycles post-replacement. Evidence type: fault diagnosis, validated.
```

### Bad entry (rejected by review queue)
```
Fixed the dryer. It works now.
```

---

## Per-Bot Evidence Templates

### Passive Income Bot

```
Niche: <niche name>
Demand signal: <search volume, forum thread count, or direct quote>
Supply gap: <what is missing or underserved>
Monetization path: <how revenue would flow>
Confidence: <0.0–1.0>
Next validation step: <specific action required before recommendation>
Blocking factors: <anything that prevents moving forward>
```

### Stocks Research Bot

```
SIMULATION — NOT REAL
Symbol: <ticker>
Signal: <indicator or pattern observed>
Entry price (simulated): <price>
Target: <price>
Stop: <price>
Hypothesis: <why this trade would work>
Evidence basis: <backtest period, sample size, win rate>
Risk/reward: <ratio>
```

### Sports Betting Bot

```
SIMULATION — NOT REAL
Event: <sport, league, matchup, date>
Market: <moneyline / spread / total>
Line: <odds>
Fair value estimate: <model probability>
Implied probability: <from line>
Edge: <fair_value - implied> (must be > 0 to log)
Confidence: <0.0–1.0>  (must be ≥ 0.65 to log)
Evidence basis: <model, sample size, historical accuracy>
Paper stake: <flat unit, no real money>
```

### Appliance Intelligence Bot

```
Appliance: <make, model, year>
Symptom: <exact symptom description>
Root cause: <diagnosed cause>
Diagnostic test: <test performed to confirm>
Fix: <part number, procedure>
Confidence: <high / medium / low>
Source: <service manual, field test, known failure pattern>
Validated: <true / false>
```

### Builder Bot

```
Change: <what was changed>
Reason: <why it was changed>
Test result: <pass / fail, test name>
Risk: <low / medium / high>
Rollback: <how to undo>
```

---

## Writing to the Evidence Log

Use the memory API from bot code. There is no direct CLI write command — entries are created programmatically by bots and marked with outcomes after the run completes.

### Step 1 — Write the entry (from bot code)

```js
const { write } = require('./scripts/memory-api.cjs')

const entry = write({
  source: 'passive-income-bot',
  category: 'execution',
  content: 'Niche: productivity apps for freelancers. Demand signal: 22k/mo search volume...',
  tags: 'domain:passive-income,evidence_type:demand_signal,outcome:unknown,confidence:medium',
  sourceRef: 'source:passive-income-bot|run:run_001',
  agent: 'passive-income-bot',
  taskId: 42,
  runId: 'run_001',
})
// entry.id is used in Step 2
```

### Step 2 — Mark the outcome after the run completes

```js
const { markOutcome } = require('./scripts/memory-api.cjs')

markOutcome(entry.id, 'success', {
  usedPatterns: [entry.id],
  primaryPatternId: entry.id,
  runId: 'run_001',
})
```

Or via CLI (for manual review actions only):

```bash
node scripts/mc-cli.cjs memory outcome <id> success \
  --used-patterns <ids> \
  --primary-pattern-id <id> \
  --run-id <runId>
```

---

## Review Queue Integration

Evidence entries are surfaced in the review queue (`/memory` → Review tab) when:
- `confidence_score >= 2 AND validation_score <= 0` — signal without validation
- `cluster_failure_count > cluster_success_count` — failure-heavy pattern
- `appliedCount < 2 AND promotion_level !== 'observation'` — promoted but rarely used

Entries flagged `STALE_HIGH_CONFIDENCE` require Owner disposition: keep or demote. Removal is an Owner-only manual action and is never performed automatically by any bot.

---

## What Does Not Count as Evidence

The following are NOT valid evidence entries and will be rejected or flagged:

| Invalid claim | Reason |
|---|---|
| "This niche is trending on Twitter" | Hype, not demand signal |
| "I think this will work" | Opinion, not observation |
| "Similar apps are successful" | Correlation, not causation |
| "The backtest was 70% win rate" | Requires sample size, period, out-of-sample test |
| "GPT says this is a good idea" | LLM inference is not evidence |
| "I ran the script and it worked" | No test name, no reproducible procedure |
