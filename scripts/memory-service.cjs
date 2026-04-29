#!/usr/bin/env node
/**
 * memory-service.cjs — shared CJS memory layer
 * Used by cli-agents.cjs, cli-memory.cjs, and future MCP tools.
 */

'use strict';

const path = require('node:path');

const HOMEDIR = process.env.HOME || process.env.USERPROFILE || '';
const MISSION_CONTROL_DIR = path.join(HOMEDIR, 'mission-control');
const DB_PATH = path.join(MISSION_CONTROL_DIR, '.data', 'mission-control.db');

let db = null;

function getDb() {
  if (!db) {
    const Database = require('better-sqlite3');
    db = new Database(DB_PATH);
  }
  return db;
}

function writeMemory(source, category, content, meta = {}) {
  const { taskId = null, agent = null, runId = null, tags = null, confidence = null, sourceRef = null, project = null, rawExecutionLog = false, usedPatterns = null } = meta;

  // Generate pattern only when explicitly requested (no heuristics)
  if (rawExecutionLog === true) {
    const pattern = generateMemoryPattern(content);

    // Discard weak patterns - insert raw content with pattern traceability
    if (!pattern.generalized_pattern || pattern.generalized_pattern.length < 20) {
      const database = getDb();
      const result = database.prepare(`
        INSERT INTO memory_entries
          (source, category, content, task_id, agent, run_id, tags, confidence, source_ref, project, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `).run(source, category, content, taskId, agent, runId, tags, confidence, sourceRef, project);
      return { id: result.lastInsertRowid };
    }

    // Persist both pattern and raw content for traceability
    const finalContent = patternToString(pattern) + '\n\n--- RAW ---\n' + content;
    const finalTags = pattern.generalized_pattern || (pattern.anti_patterns ? 'avoid:' + pattern.anti_patterns[0] : '');
    const finalSourceRef = pattern.confidence_basis ? `source:${source}|reason:pattern|${pattern.confidence_basis}` : (sourceRef || '');

    const database = getDb();
    const result = database.prepare(`
      INSERT INTO memory_entries
        (source, category, content, task_id, agent, run_id, tags, confidence, source_ref, project, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
    `).run(source, category, finalContent, taskId, agent, runId, finalTags, confidence, finalSourceRef, project);

    const { id } = result;
    meta.raw_content = content;
    meta.pattern = pattern;
    meta.generated_id = id;

    return { id };
  }

  // No pattern generation - store content as-is
  const database = getDb();
  const result = database.prepare(`
    INSERT INTO memory_entries
      (source, category, content, task_id, agent, run_id, tags, confidence, source_ref, project, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
  `).run(source, category, content, taskId, agent, runId, tags, confidence, sourceRef, project);
  return { id: result.lastInsertRowid };
}

function generateMemoryPattern(content) {
  const lower = (content || '').toLowerCase();

  // Improved outcome detection
  const isFailure = /\b(failed|error|exception|crash|timeout)\b/i.test(lower)
    && !/\b(no error|without error|handled error|resolved error)\b/i.test(lower);
  const isSuccess = /pass|success|resolved|fixed|working/i.test(lower);

  const outcomeVal = isFailure ? 'failure' : isSuccess ? 'success' : 'unknown';

  // Extract root cause
  const rootCause = lower.match(/(?:root cause|issue|problem|bug|reason|because|due to|caused by|root cause of)[\s:]+([^\.]+)/i);
  const rootCauseText = rootCause ? rootCause[1].trim() : lower.slice(0, 200).trim() || 'observation';

  // Extract trigger condition
  const triggerCondition = lower.match(/(?:trigger|triggered|when|after|on|during|preceded by|caused when)[\s:]+([^\.]+)/i);
  const triggerText = triggerCondition ? triggerCondition[1].trim() : lower.match(/(?:condition|scenario|situation|context|when|if)[\s:]+([^\.]+)/i);
  const triggerConditions = triggerText ? [triggerText.trim()] : [];

  // Extract action taken
  const actionTaken = lower.match(/(?:fixed|resolved|solved|handled|addressed|mitigated|remediated|updated|reverted|removed|changed)[\s:]+([^\.]+)/i);
  const recommendedAction = actionTaken ? actionTaken[1].trim() : 'monitor for recurrence';

  // Extract confidence basis
  const confidenceBasis = lower.match(/(?:confidence|certainty|basis|warranted by)[\s:]+([^\.]+)/i);
  const confidenceBasisText = confidenceBasis ? confidenceBasis[1].trim() : (outcomeVal ? `${outcomeVal} outcome` : 'observed behavior');

  // Generate generalized pattern
  const generalizedPattern = lower.match(/(?:recommendation|lesson|lesson learned|best practice|guideline)[\s:]+([^\.]+)/i);
  const generalizedPatternText = generalizedPattern ? generalizedPattern[1].trim() : recommendedAction;

  // Force anti-pattern generation for failures
  const antiPatterns = [];
  if (outcomeVal === 'failure') {
    const avoidMatch = lower.match(/(?:avoid|don\'t|do not|never)[\s:]+([^\.]+)/i);
    if (avoidMatch) {
      antiPatterns.push(`Avoid: ${avoidMatch[1].trim()}`);
    } else if (rootCauseText) {
      antiPatterns.push(`Do not repeat actions leading to: ${rootCauseText}`);
    }
  }

  // Determine scope limits
  const scopeLimits = lower.match(/(?:scope|limit|bound|applicable to|only for|exclude|unless)[\s:]+([^\.]+)/i);
  const scopeText = scopeLimits ? scopeLimits[1].trim() : 'general';

  return {
    generalized_pattern: generalizedPatternText,
    trigger_conditions: triggerConditions,
    recommended_action: recommendedAction,
    anti_patterns: outcomeVal === 'failure' ? antiPatterns : null,
    confidence_basis: confidenceBasisText,
    scope_limits: scopeText,
    outcome: outcomeVal
  };
}

function patternToString(pattern) {
  if (!pattern) return '';
  const lines = [pattern.generalized_pattern];
  if (pattern.trigger_conditions && pattern.trigger_conditions.length > 0) {
    lines.push(`Triggers: ${pattern.trigger_conditions.join(', ')}`);
  }
  if (pattern.recommended_action !== pattern.generalized_pattern) {
    lines.push(`Action: ${pattern.recommended_action}`);
  }
  if (pattern.confidence_basis) {
    lines.push(`Confidence: ${pattern.confidence_basis}`);
  }
  if (pattern.scope_limits && pattern.scope_limits !== 'general') {
    lines.push(`Scope: ${pattern.scope_limits}`);
  }
  if (pattern.anti_patterns) {
    for (const anti of pattern.anti_patterns) {
      lines.push(`Anti: ${anti}`);
    }
  }
  return lines.join('\n');
}

function queryMemory(searchTerm, filters = {}) {
  const { source = null, category = null } = filters;
  const database = getDb();
  let sql = `
    SELECT id, source, category, agent, task_id, run_id, tags, confidence, content, created_at
    FROM memory_entries
    WHERE (content LIKE ? OR tags LIKE ?)
  `;
  const params = [`%${searchTerm}%`, `%${searchTerm}%`];
  if (source) { sql += ' AND source = ?'; params.push(source); }
  if (category) { sql += ' AND category = ?'; params.push(category); }
  sql += ' ORDER BY created_at DESC LIMIT 20';
  return database.prepare(sql).all(...params);
}

function memoryStatus() {
  const database = getDb();
  const tables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_entries'"
  ).all();
  if (tables.length === 0) return { status: 'table_not_exists' };

  const total = database.prepare('SELECT COUNT(*) as total FROM memory_entries').get();
  const bySource = database.prepare('SELECT source, COUNT(*) as cnt FROM memory_entries GROUP BY source').all();
  const recent = database.prepare('SELECT created_at FROM memory_entries ORDER BY created_at DESC LIMIT 1').get();

  return {
    status: 'ok',
    table_exists: true,
    total: total.total,
    by_source: bySource,
    last_sync: recent ? recent.created_at : null,
  };
}

function scoreEntry(entry, prompt, taskId, now, allEntries = []) {
  const stopwords = new Set([
    'the','is','and','to','a','of','in','for','on','with','test','memory'
  ]);
  const words = prompt.toLowerCase().split(/\s+/).filter(w => w && !stopwords.has(w));
  const haystack = (entry.content + ' ' + (entry.tags || '')).toLowerCase();
  const contentMatch = words.length > 0
    ? words.filter(w => haystack.includes(w)).length / words.length
    : 0;

  const recency = 1 / (1 + (now - entry.created_at) / 86400);
  const taskBoost = entry.task_id === Number(taskId) ? 0.5 : 0;

  const outcomeMatch = (entry.tags || '').match(/outcome:(success|failure|unknown)/);
  const outcome = outcomeMatch ? outcomeMatch[1] : 'unknown';
  const outcomeWeight = outcome === 'success' ? 1 : outcome === 'failure' ? -1 : 0;

  const confidenceWeight = entry.confidence != null ? entry.confidence : 0.5;

  const phraseMatch = haystack.includes(prompt.toLowerCase()) ? 1 : 0;

  // Aggregate confidence score from source_ref history
  const sourceRef = entry.source_ref || '';
  const plusMatches = (sourceRef.match(/confidence_adjusted:\+1/g) || []).length;
  const minusMatches = (sourceRef.match(/confidence_adjusted:\-1/g) || []).length;
  const confidenceScore = plusMatches - minusMatches;

  // Apply half-life decay to prevent old patterns from dominating
  const ageSeconds = Math.max(0, now - entry.created_at);
  const halfLifeDays = 30;
  const halfLifeSeconds = halfLifeDays * 86400;
  const decayFactor = Math.pow(0.5, ageSeconds / halfLifeSeconds);
  const effectiveConfidenceScore = confidenceScore * decayFactor;

  const score = contentMatch * 2 + recency + taskBoost + outcomeWeight + confidenceWeight + phraseMatch + (effectiveConfidenceScore * 0.3);

  const learningQualityBoost = getLearningQualityBoost(entry);

  // Anti-pattern priority: failure patterns rank higher
  const isFailureMemory = /anti:|avoid|do not|failure|error/i.test(entry.content);

  // Confidence-aware failure boost
  const failureBoost = isFailureMemory
    ? 1 + Math.min(3, Math.abs(confidenceScore))
    : 0;

  // Success dampening for anti-pattern priority
  const successDampening = !isFailureMemory && /success|fixed|resolved/i.test(entry.content) ? -0.5 : 0;

  // Pattern similarity clustering
  const similarEntries = allEntries.filter(e => {
    if (e.id === entry.id) return false;
    return getPatternSimilarity(entry, e) > 0.6;
  });

  const clusterSize = similarEntries.length + 1;

  // Aggregate cluster counts
  const clusterSuccessCount =
    successCount +
    similarEntries.reduce((sum, e) =>
      sum + ((e.source_ref.match(/pattern_success:\+1/g) || []).length),
    0);

  const clusterFailureCount =
    failureCount +
    similarEntries.reduce((sum, e) =>
      sum + ((e.source_ref.match(/pattern_failure:\+1/g) || []).length),
    0);

  // Promotion level system (dynamic based on cluster counts)
  const clusterPromotionLevel = getPromotionLevelWithCounts(clusterSuccessCount, clusterFailureCount);
  const promotionBoost = getPromotionBoost(clusterPromotionLevel);

  // Demotion penalty based on cluster counts
  const demotionPenalty = getDemotionPenaltyWithCounts(clusterSuccessCount, clusterFailureCount);

  // Cluster boost
  const clusterBoost = Math.min(2, clusterSize * 0.5);

  const validationScore = getValidationScore(entry);
  const validationPenalty = validationScore < 0 ? validationScore * 2 : 0;

  // Causality Correlation: distinguish patterns that cause correct outcomes
  const causalityScore = getCausalityScore(entry);
  const causalityBoost =
    causalityScore > 0.7 ? 1.5 :
    causalityScore > 0.5 ? 0.5 :
    causalityScore < 0.3 ? -2 :
    0;

  const finalScore = score + learningQualityBoost + failureBoost + successDampening + promotionBoost + demotionPenalty + clusterBoost + validationPenalty + causalityBoost;

  // Block unsafe patterns: force demotion if validation score indicates unsafe content
  let forceDemote = false;
  if (validationScore <= -2) {
    forceDemote = true;
  }

  return {
    score: finalScore,
    contentMatch,
    phraseMatch,
    confidence_score: confidenceScore,
    effective_confidence_score: effectiveConfidenceScore,
    confidence_decay_factor: decayFactor,
    learning_quality_boost: learningQualityBoost,
    failure_boost: failureBoost,
    success_dampening: successDampening,
    promotion_level: forceDemote ? 'observation' : clusterPromotionLevel,
    promotion_boost: promotionBoost,
    demotion_penalty: forceDemote ? -10 : demotionPenalty,
    validation_score: validationScore,
    validation_penalty: validationPenalty,
    success_count: clusterSuccessCount,
    failure_count: clusterFailureCount,
    cluster_size: clusterSize,
    cluster_success_count: clusterSuccessCount,
    cluster_failure_count: clusterFailureCount,
    similarity_matches: similarEntries.length,
    is_failure_memory: isFailureMemory,
    force_demoted: forceDemote,
    causality_score: causalityScore,
    causality_boost: causalityBoost
  };
}

function getPromotionLevelWithCounts(successCount, failureCount) {
  // Demote if failures >= successes AND at least 2 failures
  if (failureCount >= successCount && failureCount >= 2) return 'observation';

  // Promote based on cluster success count
  if (successCount >= 5 && failureCount === 0) return 'core_rule';
  if (successCount >= 3 && failureCount === 0) return 'validated_pattern';
  if (successCount >= 2) return 'candidate_pattern';

  return 'observation';
}

function getDemotionPenaltyWithCounts(successCount, failureCount) {
  // Apply demotion penalty if failures outnumber successes
  if (failureCount > successCount) {
    return -2;
  }

  return 0;
}

function recallMemory(agent, taskId, prompt, limit = 3) {
  const database = getDb();
  const candidates = database.prepare(`
    SELECT id, content, agent, task_id, tags, confidence, created_at, source_ref
    FROM memory_entries
    WHERE source = ? AND category = 'execution'
    ORDER BY created_at DESC
    LIMIT 50
  `).all(agent);

  const now = Math.floor(Date.now() / 1000);
  const scored = candidates
    .map(e => ({ ...e, ...scoreEntry(e, prompt, taskId, now, candidates) }))
    .filter(e => (e.contentMatch > 0 || e.phraseMatch > 0) && e.score > 1.5)
    .sort((a, b) => b.score - a.score);

  // Mark top selected entries with used_for_decision flag for causality tracking
  const selected = scored.slice(0, limit);
  const usedPatterns = selected.map(e => e.id);

  // Pass used patterns back through pipeline for writeMemory callback
  selected.forEach((e, i) => {
    e.used_for_decision = true;
    e.use_order = i + 1;
  });

  return selected;
}

function markOutcome(id, outcome) {
  const valid = ['success', 'failure', 'unknown'];
  if (!valid.includes(outcome)) throw new Error(`Invalid outcome: ${outcome}`);

  const database = getDb();
  const row = database.prepare('SELECT tags, source_ref FROM memory_entries WHERE id = ?').get(id);
  if (!row) return { id, updated: false, reason: 'not found' };

  const current = row.tags || '';
  const updatedTags = /outcome:\w+/.test(current)
    ? current.replace(/outcome:\w+/, `outcome:${outcome}`)
    : `${current},outcome:${outcome}`;

  // Track usage signals in source_ref (always accumulate)
  let updatedSourceRef = row.source_ref;
  if (updatedSourceRef) {
    // Append pattern usage signal - tracks pre/post state correlation
    const signal = outcome === 'success' ? 'pattern_success:+1' : 'pattern_failure:+1';
    updatedSourceRef = `${updatedSourceRef}|${signal}`;

    // Track applied pattern signal ONLY if this pattern was actually used in decision
    const isUsedPattern = usedPatterns ? usedPatterns.includes(id) : false;
    if (isUsedPattern) {
      // Check if applied_pattern signal already exists to avoid duplicates
      if (!updatedSourceRef.includes('applied_pattern:')) {
        updatedSourceRef = `${updatedSourceRef}|applied_pattern:+1`;
      }
    }

    // Confidence correction: compare suggested outcome with actual outcome
    const suggestedMatch = updatedSourceRef.match(/suggested:(\w+)/);
    if (suggestedMatch && !updatedSourceRef.includes('confidence_adjusted:')) {
      const suggested = suggestedMatch[1];
      const adjustment = suggested === outcome ? '+1' : '-1';
      updatedSourceRef = `${updatedSourceRef}|confidence_adjusted:${adjustment}`;
    }
  }

  database.prepare(
    'UPDATE memory_entries SET tags = ?, source_ref = ?, updated_at = unixepoch() WHERE id = ?'
  ).run(updatedTags, updatedSourceRef, id);

  return { id, outcome, updated: true };
}

function getLearningQuality(entry) {
  const quality = entry.learning_quality || {};

  return {
    signalStrength: Number(quality.signal_strength ?? 1),
    generality: Number(quality.generality ?? 1),
    reproducibility: Number(quality.reproducibility ?? 1),
    userConfirmed: Boolean(quality.user_confirmed),
    failureSafe: quality.failure_safe !== false,
    lessonType: quality.lesson_type || 'observation'
  };
}

function getLearningQualityBoost(entry) {
  const q = getLearningQuality(entry);

  const boost =
    q.signalStrength * 0.4 +
    q.generality * 0.3 +
    q.reproducibility * 0.5 +
    (q.userConfirmed ? 1.5 : 0);

  const riskPenalty = q.failureSafe ? 0 : 2;

  return boost - riskPenalty;
}

// Pattern Validation Gate: assess pattern credibility
function getValidationScore(entry) {
  const content = entry.content || '';

  let score = 0;

  // Positive signals
  if (/tested|verified|confirmed|validated/i.test(content)) score += 2;
  if (/repeated|consistent/i.test(content)) score += 1;

  // Negative signals
  if (/temporary|workaround|hack|quick fix/i.test(content)) score -= 2;
  if (/uncertain|guess|maybe|likely/i.test(content)) score -= 1;

  return score;
}

// Causality Correlation: detect patterns that actually cause correct outcomes
// Now measures: successCount / appliedCount where appliedCount is ONLY from actual usage
function getCausalityScore(entry) {
  const sourceRef = entry.source_ref || '';

  const applied = (sourceRef.match(/applied_pattern:\+1/g) || []).length;
  const success = (sourceRef.match(/pattern_success:\+1/g) || []).length;

  if (applied === 0) return 0;

  return success / applied;
}

// Pattern similarity clustering

function getPatternSimilarity(a, b) {
  const tokensA = tokenize(a.content);
  const tokensB = tokenize(b.content);

  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let overlap = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) overlap++;
  }

  const union = new Set([...tokensA, ...tokensB]).size;

  return overlap / union;
}

function buildContext(recall) {
  const tag = e => e.tags || '';
  return {
    successfulPatterns: recall.filter(e => tag(e).includes('outcome:success')),
    failedPatterns:     recall.filter(e => tag(e).includes('outcome:failure')),
    neutralContext:     recall.filter(e => !tag(e).includes('outcome:success') && !tag(e).includes('outcome:failure')),
  };
}

function buildExecutionPrompt(prompt, context) {
  const lines = [];

  if (context.successfulPatterns.length > 0) {
    lines.push('[MEMORY CONTEXT]');
    lines.push('REQUIRED BEHAVIOR:');
    lines.push('- Prefer patterns from REUSE:');
    context.successfulPatterns.forEach(e =>
      lines.push(`  - ${e.content} (score: ${e.score != null ? e.score.toFixed(2) : 'n/a'})`));
  }
  if (context.failedPatterns.length > 0) {
    if (!lines.length) { lines.push('[MEMORY CONTEXT]'); lines.push('REQUIRED BEHAVIOR:'); }
    lines.push('- Do NOT repeat patterns from AVOID:');
    context.failedPatterns.forEach(e =>
      lines.push(`  - ${e.content} (score: ${e.score != null ? e.score.toFixed(2) : 'n/a'})`));
  }
  if (context.neutralContext.length > 0) {
    if (!lines.length) lines.push('[MEMORY CONTEXT]');
    lines.push('REFERENCE:');
    lines.push('- Neutral context for optional use:');
    context.neutralContext.forEach(e =>
      lines.push(`  - ${e.content} (score: ${e.score != null ? e.score.toFixed(2) : 'n/a'})`));
  }

  if (lines.length) lines.push('');
  lines.push(`[CURRENT TASK]: ${prompt}`);
  return lines.join('\n');
}

function classifyOutcome(result) {
  if (!result)
    return { suggested_outcome: 'unknown', suggestion_reason: 'no_result', suggestion_confidence: 'low' };

  if (result.error || result.status === 'error' || result.status === 'failed')
    return { suggested_outcome: 'failure', suggestion_reason: 'execution_error', suggestion_confidence: 'high' };

  if (result.status === 'done' || result.status === 'success' || result.status === 'complete')
    return { suggested_outcome: 'success', suggestion_reason: 'clean_completion', suggestion_confidence: 'high' };

  const msg = (result.message || '').toLowerCase();
  if (/fail|error|exception|crash|timeout|abort/.test(msg))
    return { suggested_outcome: 'failure', suggestion_reason: 'failure_keyword', suggestion_confidence: 'medium' };

  if (/success|complete|done|finish|ok/.test(msg))
    return { suggested_outcome: 'success', suggestion_reason: 'success_keyword', suggestion_confidence: 'medium' };

  return { suggested_outcome: 'unknown', suggestion_reason: 'no_signal', suggestion_confidence: 'low' };
}

function getPendingOutcomes(limit = 20) {
  const database = getDb();
  const rows = database.prepare(`
    SELECT id, content, source_ref, tags, created_at
    FROM memory_entries
    WHERE tags     LIKE '%outcome:unknown%'
      AND source_ref LIKE '%suggested:%'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);

  return rows.map(r => {
    const sug = (r.source_ref || '').match(/suggested:(\w+)/);
    const rsn = (r.source_ref || '').match(/reason:(\w+)/);
    const conf = (r.source_ref || '').match(/confidence:(\w+)/);
    return {
      id:                r.id,
      content_preview:   r.content.substring(0, 120),
      suggested_outcome: sug ? sug[1] : null,
      suggestion_reason: rsn ? rsn[1] : null,
      suggestion_confidence: conf ? conf[1] : null,
      source_ref:        r.source_ref,
      created_at:        r.created_at,
    };
  });
}

function getOutcomeSuggestion(id) {
  const database = getDb();
  const row = database.prepare(
    'SELECT id, tags, source_ref FROM memory_entries WHERE id = ?'
  ).get(id);

  if (!row) return null;
  if (!(row.tags || '').includes('outcome:unknown')) return null;
  if (!(row.source_ref || '').includes('suggested:')) return null;

  const match = (row.source_ref || '').match(/suggested:(\w+)/);
  if (!match) return null;

  return { id: row.id, suggested_outcome: match[1] };
}

function approveOutcomes(filter = null, dryRun = false, confidenceFilter = null) {
  const valid = ['success', 'failure', 'unknown'];
  if (filter !== null && !valid.includes(filter))
    throw new Error(`Invalid filter: ${filter}. Must be success | failure | unknown`);

  const validConfidence = ['high', 'medium', 'low'];
  if (confidenceFilter !== null && !validConfidence.includes(confidenceFilter))
    throw new Error(`Invalid confidence filter: ${confidenceFilter}. Must be high | medium | low`);

  const pending = getPendingOutcomes(1000);
  const targets = pending.filter(e => {
    if (filter && e.suggested_outcome !== filter) return false;
    if (confidenceFilter && e.suggestion_confidence !== confidenceFilter) return false;
    return true;
  });

  const breakdown = {};
  let applied = 0;

  for (const entry of targets) {
    try {
      if (!dryRun) {
        markOutcome(entry.id, entry.suggested_outcome);
      }
      breakdown[entry.suggested_outcome] = (breakdown[entry.suggested_outcome] || 0) + 1;
      applied++;
    } catch {}
  }

  return { total_processed: targets.length, total_applied: dryRun ? 0 : applied, breakdown };
}

module.exports = {
  writeMemory,
  queryMemory,
  memoryStatus,
  recallMemory,
  markOutcome,
  buildContext,
  buildExecutionPrompt,
  classifyOutcome,
  getPendingOutcomes,
  getOutcomeSuggestion,
  approveOutcomes,
  getLearningQuality,
  getLearningQualityBoost,
  generateMemoryPattern,
  patternToString,
  getPromotionLevel,
  getPromotionBoost,
  getDemotionPenalty,
  getPromotionLevelWithCounts,
  getDemotionPenaltyWithCounts,
  tokenize,
  getPatternSimilarity
};
