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
  const { taskId = null, agent = null, runId = null, tags = null, confidence = null, sourceRef = null, project = null } = meta;
  const database = getDb();
  const result = database.prepare(`
    INSERT INTO memory_entries
      (source, category, content, task_id, agent, run_id, tags, confidence, source_ref, project, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
  `).run(source, category, content, taskId, agent, runId, tags, confidence, sourceRef, project);
  return { id: result.lastInsertRowid };
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

function scoreEntry(entry, prompt, taskId, now) {
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

  const score = contentMatch * 2 + recency + taskBoost + outcomeWeight + confidenceWeight + phraseMatch;
  return { score, contentMatch, phraseMatch };
}

function recallMemory(agent, taskId, prompt, limit = 3) {
  const database = getDb();
  const candidates = database.prepare(`
    SELECT id, content, agent, task_id, tags, confidence, created_at
    FROM memory_entries
    WHERE source = ? AND category = 'execution'
    ORDER BY created_at DESC
    LIMIT 50
  `).all(agent);

  const now = Math.floor(Date.now() / 1000);
  return candidates
    .map(e => ({ ...e, ...scoreEntry(e, prompt, taskId, now) }))
    .filter(e => (e.contentMatch > 0 || e.phraseMatch > 0) && e.score > 1.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
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

  // Confidence correction: compare suggested outcome with actual outcome
  let updatedSourceRef = row.source_ref;
  if (row.source_ref) {
    const suggestedMatch = row.source_ref.match(/suggested:(\w+)/);
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

module.exports = { writeMemory, queryMemory, memoryStatus, recallMemory, markOutcome, buildContext, buildExecutionPrompt, classifyOutcome, getPendingOutcomes, getOutcomeSuggestion, approveOutcomes };
