# Bot Output Templates

**Version**: 1.0.0
**Date**: 2026-05-01
**Status**: Active

All bot outputs are **drafts**. No output is published, sent, or acted upon without Owner explicit approval. Each template includes a `DRAFT — NOT APPROVED` header that is stripped only upon Owner sign-off.

---

## Passive Income Bot — Opportunity Brief

```markdown
# DRAFT — NOT APPROVED
# Passive Income Opportunity Brief
Generated: <ISO timestamp>
Run ID: <run_id>
Bot: passive-income-bot
Risk Level: 1 (Draft)

---

## Opportunity Summary

**Niche**: <niche name>
**Category**: <digital product / service / content / tool>
**Stage**: Idea (not validated)

## Demand Evidence

| Signal | Source | Value | Quality |
|--------|--------|-------|---------|
| Search volume | <tool> | <n>/mo | primary |
| Forum threads | <url> | <n> posts | secondary |
| Competitor count | <method> | <n> | secondary |

**Demand confidence**: <0.0–1.0>

## Supply Gap

<What exists, what is missing, why the gap persists>

## Monetization Path

**Model**: <one-time sale / subscription / affiliate / licensing>
**Price hypothesis**: $<n>/mo or $<n> one-time
**Revenue estimate**: $<low>–$<high>/mo at steady state
**Assumptions**: <list key assumptions>

## Risk Factors

| Risk | Severity | Mitigation |
|------|----------|------------|
| <risk> | high/med/low | <mitigation> |

## Next Validation Step

**Required before any build action**: <specific, measurable validation task>
**Effort estimate**: <hours>
**Blocking factor**: <what would kill this opportunity>

## Evidence Log IDs

Memory entries supporting this brief: [<id1>, <id2>, ...]

---
STATUS: AWAITING OWNER REVIEW
APPROVE → run validation step | REJECT → log reason + close
```

---

## Stocks Research Bot — Simulation Report

```markdown
# DRAFT — NOT APPROVED
# SIMULATION — NOT REAL
# Paper Trading Report
Generated: <ISO timestamp>
Run ID: <run_id>
Bot: stocks-research-bot
Risk Level: 2 (Test/Simulation)

---

## Portfolio Summary (Simulated)

**Period**: <start> to <end>
**Starting capital (paper)**: $10,000
**Ending value (paper)**: $<n>
**Return**: <n>%
**Benchmark (SPY)**: <n>%

## Strategy

**Name**: <strategy name>
**Rules**: <entry, exit, position sizing>
**Universe**: <symbols or filters>

## Trade Log (Paper)

| Date | Symbol | Action | Price | Shares | P&L |
|------|--------|--------|-------|--------|-----|
| <date> | <TICKER> | BUY | $<n> | <n> | — |

## Metrics

| Metric | Value |
|--------|-------|
| Win rate | <n>% |
| Avg win | $<n> |
| Avg loss | $<n> |
| Max drawdown | <n>% |
| Sharpe ratio | <n> |

## Evidence Basis

Backtest period: <n> years
Sample size: <n> trades
Out-of-sample: <yes/no>

## Next Step

<what needs to happen before this strategy is considered validated>

---
STATUS: AWAITING OWNER REVIEW
THIS IS A SIMULATION. NO REAL MONEY HAS BEEN INVESTED OR RISKED.
```

---

## Sports Betting Bot — Edge Report

```markdown
# DRAFT — NOT APPROVED
# SIMULATION — NOT REAL
# Sports Betting Edge Report
Generated: <ISO timestamp>
Run ID: <run_id>
Bot: sports-betting-bot
Risk Level: 2 (Test/Simulation)

---

## Paper Bet Candidates (Simulated)

| Event | Market | Line | Fair Value | Edge | Confidence | Paper Stake |
|-------|--------|------|------------|------|------------|-------------|
| <sport/matchup/date> | <type> | <odds> | <model prob> | <edge> | <conf> | 1 unit |

**Unit size**: 1% of simulated bankroll (no real money)

## Model Performance (Last 30 days paper)

| Metric | Value |
|--------|-------|
| Paper bets placed | <n> |
| Win rate | <n>% |
| ROI (simulated) | <n>% |
| CLV (closing line value) | <n>% |

## Edge Calculation

Fair value derived from: <model description>
Sample size for model: <n> historical events
Model accuracy (holdout): <n>%

**Gate check**: All entries above have edge > 0 and confidence ≥ 0.65.
Entries below threshold are excluded and logged as `outcome:unknown`.

## Caveats

<known model weaknesses, market conditions that invalidate the edge>

---
STATUS: AWAITING OWNER REVIEW
THIS IS A SIMULATION. NO REAL BETS HAVE BEEN PLACED.
NO BOOKMAKER ACCOUNT HAS BEEN CONNECTED.
```

---

## Appliance Intelligence Bot — Fault Report

```markdown
# DRAFT — NOT APPROVED
# Appliance Fault Diagnosis
Generated: <ISO timestamp>
Run ID: <run_id>
Bot: appliance-bot
Risk Level: 1 (Draft)

---

## Device

**Appliance**: <make, model, year>
**Symptom reported**: <exact symptom>
**Operating hours**: <if known>

## Diagnosis

**Root cause**: <specific component or condition>
**Confidence**: <high / medium / low>
**Diagnostic test**: <test performed or recommended>
**Test result**: <pass/fail/inconclusive>

## Repair Plan

| Step | Action | Part | Estimated cost |
|------|--------|------|----------------|
| 1 | <action> | <part number> | $<n> |

## Safety Notes

<any safety precautions — disconnect power, etc.>

## Evidence Basis

| Source | Type | Quality |
|--------|------|---------|
| <service manual section> | primary | high |
| <known failure pattern> | secondary | medium |

---
STATUS: AWAITING OWNER REVIEW
```
---

## Builder Bot — Change Report

```markdown
# DRAFT — NOT APPROVED
# Code Change Report
Generated: <ISO timestamp>
Run ID: <run_id>
Bot: builder-bot
Risk Level: <n> (0–5; see RISK_AND_APPROVAL_POLICY.md)

---

## Change Summary

**Type**: <feat / fix / refactor / chore>
**Scope**: <files/systems affected>
**Description**: <what changed and why>

## Test Results

| Test suite | Result | Duration |
|------------|--------|----------|
| pnpm typecheck | PASS/FAIL | <n>s |
| pnpm lint | PASS/FAIL | <n>s |
| pnpm test | PASS/FAIL (<n>/<n> tests) | <n>s |
| pnpm build | PASS/FAIL | <n>s |

## Risk Assessment

**Risk level**: <n>
**Rollback**: <procedure>
**Production impact**: <none / minor / major>

## Approval Required

<list any gates that require Owner approval>

---
STATUS: AWAITING OWNER REVIEW
```
