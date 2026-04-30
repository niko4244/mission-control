#!/usr/bin/env node
/**
 * memory-api.cjs — stable API boundary for Mission Control UI
 *
 * Wraps memory-service.cjs and exposes UI-safe functions with stable shapes.
 * All functions are deterministic and return consistent object shapes.
 */

'use strict';

const path = require('node:path');
const memoryService = require('./memory-service.cjs');

// Database path
const HOMEDIR = process.env.HOME || process.env.USERPROFILE || '';
const DB_PATH = process.env.MISSION_CONTROL_DATA_DIR
  ? path.join(process.env.MISSION_CONTROL_DATA_DIR, '.data', 'mission-control.db')
  : path.join(HOMEDIR, 'mission-control', '.data', 'mission-control.db');

// Initialize DB instance in memory-api for direct access
const db = new (require('better-sqlite3'))(DB_PATH);

// Export getDb for tests
memoryService.getDb = function() {
  if (!this._db) {
    this._db = db;
  }
  return this._db;
};

/**
 * Generate human-readable explanation for a scored entry
 */
function generateExplanation(entry, score) {
  const explanations = [];

  // Content match contribution
  if (score.contentMatch > 0.5) {
    explanations.push(`matched ${Math.round(score.contentMatch * 100)}% of prompt terms`);
  }

  // Outcome contribution
  if (entry.outcome === 'success') {
    explanations.push('has success outcome');
  } else if (entry.outcome === 'failure') {
    explanations.push('has failure outcome (anti-pattern priority)');
  }

  // Promotion level
  if (score.promotion_level !== 'observation') {
    explanations.push(`promoted as ${score.promotion_level}`);
  }

  // Cluster signals
  if (score.cluster_success_count > 0) {
    explanations.push(`${score.cluster_success_count} success signals in cluster`);
  }

  if (score.cluster_failure_count > 0) {
    explanations.push(`${score.cluster_failure_count} failure signals in cluster`);
  }

  // Validation evidence
  if (score.validation_score > 1) {
    explanations.push('positive validation evidence');
  }

  // Failure boost
  if (score.failure_boost > 0) {
    explanations.push('failure memory boost');
  }

  // Causality boost
  if (score.causality_boost > 0) {
    explanations.push(`high causality (${score.causality_score})`);
  }

  // Phrasing match
  if (score.phraseMatch > 0) {
    explanations.push('exact phrase match in content');
  }

  // Default explanation
  if (explanations.length === 0) {
    return 'Ranked by base score with recency, outcome, and confidence';
  }

  return explanations.join(', ');
}

/**
 * Check if scores are deterministic
 */
function isDeterministicScoring() {
  const entry = {
    content: 'Test entry for scoring.',
    tags: 'outcome:unknown',
    confidence: 0.5,
    created_at: Math.floor(Date.now() / 1000),
    source_ref: 'source:cli'
  };
  const now = Math.floor(Date.now() / 1000);

  const score1 = memoryService.scoreEntry(entry, 'test prompt', 1, now);
  const score2 = memoryService.scoreEntry(entry, 'test prompt', 1, now);

  return score1.score === score2.score;
}

/**
 * Check if DB is accessible
 */
function isDbAccessible() {
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    return tables.length > 0;
  } catch {
    return false;
  }
}

/**
 * Check that all required exports exist
 */
function checkRequiredExports() {
  const required = [
    'scoreEntry',
    'recallMemory',
    'markOutcome',
    'writeMemory',
    'getSignalCounts',
    'getPatternSimilarity',
    'getValidationScore'
  ];

  return required.every(fn => typeof memoryService[fn] === 'function');
}

/**
 * Check for NaN scores
 */
function checkNoNaN() {
  const entry = {
    content: 'Test',
    tags: 'outcome:unknown',
    created_at: Math.floor(Date.now() / 1000)
  };
  const score = memoryService.scoreEntry(entry, 'test', 1, Math.floor(Date.now() / 1000));
  return !Number.isNaN(score.score);
}

/**
 * Recall memories for a prompt
 */
function recall(agent, options = {}) {
  const {
    prompt = 'recall',
    taskId = null,
    runId = null,
    limit = 3,
    explore = false,
    randomExplore = false
  } = options;

  const result = memoryService.recallMemory(agent, prompt, taskId, {
    limit,
    runId,
    explore,
    randomExplore
  });

  // Build explanations for selected memories
  const selectedWithExplanation = result.selected.map(e => {
    const score = memoryService.scoreEntry(e, prompt, taskId, Math.floor(Date.now() / 1000), result.selected);
    return {
      id: e.id,
      content: e.content,
      tags: e.tags,
      source_ref: e.source_ref,
      score: score.score,
      promotion_level: score.promotion_level,
      validation_score: score.validation_score,
      cluster_validation_score: score.cluster_validation_score,
      causality_score: score.causality_score,
      win_rate: score.win_rate,
      cluster_size: score.cluster_size,
      cluster_success_count: score.cluster_success_count,
      cluster_failure_count: score.cluster_failure_count,
      cluster_applied_count: score.cluster_applied_count,
      cluster_win_count: score.cluster_win_count,
      cluster_loss_count: score.cluster_loss_count,
      failure_boost: score.failure_boost,
      promotion_boost: score.promotion_boost,
      validation_penalty: score.validation_penalty,
      causality_boost: score.causality_boost,
      competition_boost: score.competition_boost,
      cluster_boost: score.cluster_boost,
      demotion_penalty: score.demotion_penalty,
      explanation: generateExplanation(e, score)
    };
  });

  return {
    prompt,
    runId: runId || null,
    selected: selectedWithExplanation,
    usedPatterns: result.usedPatterns,
    primaryPatternId: null, // Set when marking outcome
    pruned_count: result.pruned_count,
    merged_count: result.merged_count
  };
}

/**
 * Audit: return top scored memories with full debug info
 */
function audit(agent, options = {}) {
  const {
    prompt = 'audit',
    taskId = null,
    limit = 10
  } = options;

  const candidates = db.prepare(`
    SELECT id, content, agent, task_id, tags, confidence, created_at, source_ref
    FROM memory_entries
    WHERE source = ? AND category = 'execution'
    ORDER BY created_at DESC
    LIMIT 50
  `).all(agent);

  const now = Math.floor(Date.now() / 1000);

  // Score all candidates
  const scored = candidates.map(e => ({
    ...e,
    ...memoryService.scoreEntry(e, prompt, taskId, now, candidates)
  }));

  // Filter and sort
  const scoredFiltered = scored
    .filter(e => e.contentMatch > 0 || e.phraseMatch > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Build detailed entries
  const entries = scoredFiltered.map(e => ({
    id: e.id,
    content: e.content,
    tags: e.tags,
    source_ref: e.source_ref,
    score: e.score,
    promotion_level: e.promotion_level,
    validation_score: e.validation_score,
    cluster_validation_score: e.cluster_validation_score,
    causality_score: e.causality_score,
    win_rate: e.win_rate,
    cluster_size: e.cluster_size,
    cluster_success_count: e.cluster_success_count,
    cluster_failure_count: e.cluster_failure_count,
    cluster_applied_count: e.cluster_applied_count,
    cluster_win_count: e.cluster_win_count,
    cluster_loss_count: e.cluster_loss_count,
    failure_boost: e.failure_boost,
    promotion_boost: e.promotion_boost,
    validation_penalty: e.validation_penalty,
    causality_boost: e.causality_boost,
    competition_boost: e.competition_boost,
    cluster_boost: e.cluster_boost,
    demotion_penalty: e.demotion_penalty,
    explanation: generateExplanation(e, e)
  }));

  // Build warnings
  const warnings = [];
  entries.forEach(entry => {
    // High score but no validation
    if (entry.score > 4 && entry.validation_score <= 1) {
      warnings.push({
        entryId: entry.id,
        reason: 'high score but low validation evidence',
        severity: 'warning'
      });
    }
    // High score but failure-heavy
    if (entry.score > 4 && entry.cluster_failure_count > entry.cluster_success_count) {
      warnings.push({
        entryId: entry.id,
        reason: 'high score but failure-heavy cluster',
        severity: 'warning'
      });
    }
    // High score with low content match
    if (entry.score > 4 && entry.contentMatch < 0.3) {
      warnings.push({
        entryId: entry.id,
        reason: 'high score with low content match',
        severity: 'warning'
      });
    }
  });

  return {
    prompt,
    runId: null,
    entries,
    summary: {
      total_candidates: scored.length,
      returned: entries.length,
      pruned_count: scored.length - entries.length,
      merged_count: 0,
      top_score: entries.length > 0 ? entries[0].score : 0,
      warning_count: warnings.length,
      warnings
    }
  };
}

/**
 * Write memory entry
 */
function write(options = {}) {
  const {
    source = 'manual',
    category = 'execution',
    agent = null,
    taskId = null,
    runId = null,
    tags = null,
    confidence = null,
    sourceRef = null,
    project = null,
    rawExecutionLog = false
  } = options;

  return memoryService.writeMemory(source, category, options.content, {
    taskId,
    agent,
    runId,
    tags,
    confidence,
    sourceRef,
    project,
    rawExecutionLog
  });
}

/**
 * Mark outcome for a memory entry
 */
function markOutcome(id, outcome, options = {}) {
  const {
    usedPatterns = [],
    primaryPatternId = null,
    runId = null
  } = options;

  return memoryService.markOutcome(id, outcome, {
    usedPatterns,
    primaryPatternId,
    runId
  });
}

/**
 * Get memory status
 */
function status() {
  const total = db.prepare('SELECT COUNT(*) as count FROM memory_entries').get();

  const bySource = db.prepare('SELECT source, COUNT(*) as count FROM memory_entries GROUP BY source').all();
  const byCategory = db.prepare('SELECT category, COUNT(*) as count FROM memory_entries GROUP BY category').all();

  const outcomeCounts = db.prepare(`
    SELECT
      CASE WHEN tags LIKE '%outcome:success%' THEN 'success'
           WHEN tags LIKE '%outcome:failure%' THEN 'failure'
           ELSE 'unknown' END as outcome,
      COUNT(*) as count
    FROM memory_entries
    GROUP BY outcome
  `).all();

  const promotedCounts = db.prepare(`
    SELECT
      CASE
        WHEN source_ref LIKE '%pattern_win%' AND tags LIKE '%outcome:success%' THEN 'core_rule'
        WHEN source_ref LIKE '%pattern_win%' AND (tags LIKE '%outcome:success%' OR tags LIKE '%outcome:unknown%') THEN 'validated_pattern'
        WHEN tags LIKE '%outcome:success%' THEN 'candidate_pattern'
        ELSE 'observation'
      END as promotion_level,
      COUNT(*) as count
    FROM memory_entries
    GROUP BY promotion_level
  `).all();

  const recent = db.prepare(`
    SELECT id, created_at, content
    FROM memory_entries
    ORDER BY created_at DESC
    LIMIT 10
  `).all();

  const warnings = [];
  if (total.count === 0) {
    warnings.push('no memories stored yet');
  }

  return {
    ok: true,
    total_memories: total.count,
    by_source: bySource,
    by_category: byCategory,
    outcome_counts: outcomeCounts.reduce((acc, row) => ({ ...acc, [row.outcome]: row.count }), {}),
    promoted_counts: promotedCounts.reduce((acc, row) => ({ ...acc, [row.promotion_level]: row.count }), {}),
    recent_count: recent.length,
    warnings
  };
}

/**
 * Health check
 */
function health() {
  const checks = {
    memory_db_accessible: isDbAccessible(),
    required_exports_present: checkRequiredExports(),
    deterministic_scoring: isDeterministicScoring(),
    no_nan_score: checkNoNaN()
  };

  const issues = [];
  if (!checks.memory_db_accessible) {
    issues.push('database not accessible');
  }
  if (!checks.required_exports_present) {
    issues.push('missing required exports');
  }
  if (!checks.deterministic_scoring) {
    issues.push('scoring is not deterministic');
  }
  if (!checks.no_nan_score) {
    issues.push('score returned NaN');
  }

  return {
    ok: issues.length === 0,
    checks,
    issues
  };
}

module.exports = {
  recall,
  audit,
  write,
  markOutcome,
  status,
  health
};
