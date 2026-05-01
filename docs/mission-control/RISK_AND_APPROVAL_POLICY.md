# Risk and Approval Policy

**Version**: 1.0.0
**Date**: 2026-05-01
**Status**: Active — all bots and skills are bound by this policy

---

## Risk Levels

| Level | Name | Description | Default gate |
|---|---|---|---|
| 0 | Observe | Read-only. Fetch, recall, analyze. No writes. | None |
| 1 | Draft | Write to local storage only. No external effects. | None |
| 2 | Test | Simulation only. Paper trades, paper bets, dry-run deploys. | Systems Curator review |
| 3 | Controlled Action | Real write to external service (PR, issue, cron). No money. | Owner notification |
| 4 | External Action | Publishes content, sends messages, registers accounts. | Owner explicit approval |
| 5 | Financial Risk | Any action involving real money, real trades, or real bets. | Owner explicit approval per action |

Bots have a **maximum risk ceiling** defined in the Agent Registry. A bot may never execute an action above its ceiling regardless of task instruction.

---

## Hard Approval Rules

The following actions are **unconditionally blocked** without Owner explicit approval. No bot, no task, no agent instruction may bypass these:

### Financial Safety
- No real money spent for any reason (APIs, services, subscriptions)
- No real trade submitted to any brokerage
- No real bet placed with any bookmaker
- No paid API key activated without Owner approval

### Content Safety
- No content published to any public platform (social, blog, email, marketplace)
- No product listing created on any real marketplace
- No domain or hosting account registered

### Infrastructure Safety
- No production deployment without Owner approval
- No force-push to `main` branch
- No CI/CD pipeline modification without Owner review
- No production database schema drop or irreversible migration
- No core file or tool deleted without Owner approval

### Dependency Safety
- No major version dependency upgrade without Owner approval and passing test suite
- No new runtime dependency added without justification in evidence log

### Evidence and Learning Rules
- **No recommendation without evidence.** A bot may not recommend an action unless an evidence log entry supports it.
- **No evidence log means no learning.** Outcomes not recorded in the memory system are invisible to the learning loop and will not improve future recall.
- **Hype is not evidence.** "Trending", "popular", "everyone is doing it" are not valid evidence entries.
- **No edge means no bet or trade.** The Sports Betting Bot and Stocks Bot must compute a positive expected value with confidence ≥ 0.65 before logging even a paper action.
- **No buyer means no product.** Passive Income Bot may not recommend building a product without at minimum one documented demand signal (search volume, forum thread, direct conversation).
- **No test means no validated engineering rule.** Builder Bot may not promote a code pattern to `validated_pattern` without a passing test or CI run as evidence.

---

## Approval Flow

```
Bot produces Level 3+ output
        ↓
Gate check: is action ≤ bot's risk ceiling?
        ↓ YES (within ceiling)              ↓ NO (exceeds ceiling)
Queue for Owner review                Reject immediately
(status: pending_approval)            Log violation to activity stream
        ↓                             Bot suspended on repeated violations
Systems Curator notified
        ↓
Owner reviews draft output + evidence log
        ↓
  APPROVE                         REJECT
     ↓                               ↓
Bot executes action            Log rejection reason
Bot writes success outcome     Bot writes failure outcome
to memory                      to memory
```

---

## Evidence Requirement per Level

| Level | Minimum evidence before action |
|---|---|
| 0 | None |
| 1 | None (drafts only) |
| 2 | At least 1 evidence log entry supporting the simulation design |
| 3 | At least 3 supporting evidence entries; 0 blocking entries |
| 4 | Human-reviewed evidence summary; Owner approval |
| 5 | Owner approval with full evidence package; no automated path |

---

## Violation Handling

If a bot attempts an action above its risk ceiling:
1. Action is blocked immediately
2. Violation is logged to the activity stream
3. Systems Curator is notified
4. The offending task is marked `blocked`
5. Owner is notified for Level 4–5 violations

Repeated violations by a bot cause the bot to be suspended pending audit.

---

## Paper vs Real Distinction

"Paper" means **no real money, real accounts, or real external effects**. Simulations must use:
- Historical data or delayed prices (not live order books)
- Sandboxed state (paper portfolio, paper bet log) stored in Mission Control only
- Outputs clearly labeled `SIMULATION — NOT REAL`

The following are not paper actions and require Level 5 approval:
- Connecting to a live brokerage API with credentials
- Connecting to a live bookmaker API with credentials
- Using any API that can submit real orders or bets
