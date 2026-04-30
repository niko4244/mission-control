# Mission Control Memory UI Contract

This document specifies the exact data shapes and API contracts for building the Mission Control memory UI. All functions are deterministic and return consistent object shapes.

## API Functions

### 1. `recall(agent, options)`

Recall memories for a given prompt.

**Input:**
```typescript
interface RecallOptions {
  agent: string
  taskId?: string | number
  runId?: string
  limit: number
  explore?: boolean
  randomExplore?: boolean
}
```

**Output:**
```typescript
interface RecallResult {
  prompt: string
  runId: string | null
  selected: MemoryEntry[]
  usedPatterns: number[]
  primaryPatternId: number | null
  pruned_count: number
  merged_count: number
}

interface MemoryEntry {
  id: number
  content: string
  tags: string
  source_ref: string
  score: number
  promotion_level: 'core_rule' | 'validated_pattern' | 'candidate_pattern' | 'observation'
  validation_score: number
  cluster_validation_score: number
  causality_score: number
  win_rate: number
  cluster_size: number
  cluster_success_count: number
  cluster_failure_count: number
  cluster_applied_count: number
  cluster_win_count: number
  cluster_loss_count: number
  failure_boost: number
  promotion_boost: number
  validation_penalty: number
  causality_boost: number
  competition_boost: number
  cluster_boost: number
  demotion_penalty: number
  explanation: string
}
```

**Usage:**
```bash
mc memory recall "validate input" --agent hermes --limit 3
```

---

### 2. `audit(agent, options)`

Audit top-ranked memories with full debug info.

**Input:**
```typescript
interface AuditOptions {
  agent: string
  taskId?: string | number
  limit: number
  runId?: string
}
```

**Output:**
```typescript
interface AuditResult {
  prompt: string
  runId: string | null
  entries: MemoryEntry[]
  summary: AuditSummary
}

interface AuditSummary {
  total_candidates: number
  returned: number
  pruned_count: number
  merged_count: number
  top_score: number
  warning_count: number
  warnings: Array<{
    entryId: number
    reason: string
    severity: 'warning'
  }>
}
```

**Usage:**
```bash
mc memory audit "handle timeout" --agent hermes --limit 10
```

---

### 3. `write(options)`

Write a new memory entry.

**Input:**
```typescript
interface WriteOptions {
  source: string
  category: string
  content: string
  agent?: string
  taskId?: string
  runId?: string
  tags?: string
  confidence?: number
  sourceRef?: string
  project?: string
  rawExecutionLog?: boolean
}
```

**Output:**
```typescript
interface WriteResult {
  id: number
  source_ref?: string
}
```

**Usage:**
```bash
mc memory write "Always validate inputs..." --source cli --category execution
```

---

### 4. `markOutcome(id, outcome, options)`

Mark outcome for a memory entry.

**Input:**
```typescript
interface MarkOutcomeOptions {
  usedPatterns: number[]
  primaryPatternId: number | null
  runId: string
}
```

**Output:**
```typescript
interface MarkOutcomeResult {
  id: number
  outcome: 'success' | 'failure' | 'unknown'
  updated: boolean
  reason?: string
  tags?: string
  outcome_tag?: string
}
```

**Usage:**
```bash
mc memory outcome 3 success --used-patterns 1,2,3 --primary-pattern-id 1 --run-id run_abc
```

---

### 5. `status()`

Get memory status.

**Output:**
```typescript
interface StatusResult {
  ok: boolean
  total_memories: number
  by_source: Array<{ source: string; count: number }>
  by_category: Array<{ category: string; count: number }>
  outcome_counts: { success: number; failure: number; unknown: number }
  promoted_counts: { core_rule: number; validated_pattern: number; candidate_pattern: number; observation: number }
  recent_count: number
  warnings: string[]
}
```

**Usage:**
```bash
mc memory status
```

---

### 6. `health()`

Check system health.

**Output:**
```typescript
interface HealthResult {
  ok: boolean
  checks: {
    memory_db_accessible: boolean
    required_exports_present: boolean
    deterministic_scoring: boolean
    no_nan_score: boolean
  }
  issues: string[]
}
```

**Usage:**
```bash
mc memory health
```

---

## UI Panels

### Memory Recall Panel

**Data needed:** `recall()` result
**API function:** `recall()`
**Mutation risk:** Medium (writes patterns on outcome marking)
**Safety controls:**
- Always show promotion level
- Show warnings for low-validation entries
- Confirm outcome marking

### Memory Audit Panel

**Data needed:** `audit()` result
**API function:** `audit()`
**Mutation risk:** None (read-only)
**Safety controls:**
- Show all debug fields
- Highlight warnings prominently
- Provide clear explanations

### Outcome Review Panel

**Data needed:** Memory details, outcome counts
**API function:** `status()`, `markOutcome()`
**Mutation risk:** High (writes to database)
**Safety controls:**
- Confirm outcomes before marking
- Show signal accumulation effects
- Warn about overwriting existing outcomes

### Memory Status Panel

**Data needed:** `status()` result
**API function:** `status()`
**Mutation risk:** None (read-only)
**Safety controls:** N/A

### Pattern Detail Drawer

**Data needed:** Single memory entry with full debug info
**API function:** `recall()` or `audit()` with single entry
**Mutation risk:** Low (view-only details)
**Safety controls:** N/A

---

## Data Contracts

### Memory Entry Shape

All memory entries returned by API functions conform to this shape:

```typescript
interface MemoryEntry {
  id: number                    // Unique identifier
  content: string               // Memory content (markdown)
  tags: string                  // Comma-separated tags
  source_ref: string            // Signal tracking reference
  
  // Scoring fields
  score: number                 // Final score
  contentMatch: number          // Prompt content match (0-1)
  phraseMatch: number           // Exact phrase match (0 or 1)
  confidence_score: number      // Confidence from signals
  effective_confidence_score: number  // After half-life decay
  confidence_decay_factor: number    // Decay factor
  
  // Validation fields
  validation_score: number      // Positive: strong evidence, Negative: weak/unsafe
  cluster_validation_score: number  // Aggregate across similar entries
  validation_penalty: number    // Applied penalty (0 or negative)
  
  // Promotion fields
  promotion_level: 'core_rule' | 'validated_pattern' | 'candidate_pattern' | 'observation'
  promotion_boost: number       // 3, 2, 0.5, or 0
  demotion_penalty: number      // -2 or 0
  
  // Cluster fields
  cluster_size: number          // 1 + similar entries
  cluster_boost: number         // min(2, clusterSize * 0.5)
  cluster_success_count: number
  cluster_failure_count: number
  cluster_applied_count: number
  cluster_win_count: number
  cluster_loss_count: number
  
  // Causality
  causality_score: number       // 0-1, based on success/applied ratio
  causality_boost: number       // (causalityScore - 0.5) * 3
  
  // Competition
  win_rate: number              // Laplace-smoothed win rate
  competition_boost: number     // 1.5, -1, or 0
  
  // Exploration/Saturation
  exploration_boost_for_underused: number  // 1 if underused, 0 otherwise
  saturation_penalty: number     // -1 if oversaturated
  
  // Failure boost
  failure_boost: number         // For failure memories
  success_dampening: number     // Dampen success dampening
  
  // Similarity
  similarity_matches: number    // Number of similarity matches
  
  // Debug
  is_failure_memory: boolean
  force_demoted: boolean
  
  // Explanation (for UI)
  explanation: string           // Human-readable ranking explanation
}
```

---

## Migration Notes

### Breaking Changes

None. All functions maintain backward compatibility.

### Deprecations

None.

### New Features

- `explanation` field on memory entries for UI clarity
- Warnings in audit results for suspicious ranking
- `health()` endpoint for system diagnostics

---

## Version

**Version:** 1.0.0  
**Date:** 2026-04-29  
**Stability:** Stable
