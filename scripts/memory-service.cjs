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
  const row = database.prepare('SELECT tags FROM memory_entries WHERE id = ?').get(id);
  if (!row) return { id, updated: false, reason: 'not found' };

  const current = row.tags || '';
  const updated = /outcome:\w+/.test(current)
    ? current.replace(/outcome:\w+/, `outcome:${outcome}`)
    : `${current},outcome:${outcome}`;

  database.prepare(
    'UPDATE memory_entries SET tags = ?, updated_at = unixepoch() WHERE id = ?'
  ).run(updated, id);

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
    return { suggested_outcome: 'unknown', suggestion_reason: 'no_result' };

  if (result.error || result.status === 'error' || result.status === 'failed')
    return { suggested_outcome: 'failure', suggestion_reason: 'execution_error' };

  if (result.status === 'done' || result.status === 'success' || result.status === 'complete')
    return { suggested_outcome: 'success', suggestion_reason: 'clean_completion' };

  const msg = (result.message || '').toLowerCase();
  if (/fail|error|exception|crash|timeout|abort/.test(msg))
    return { suggested_outcome: 'failure', suggestion_reason: 'failure_keyword' };

  if (/success|complete|done|finish|ok/.test(msg))
    return { suggested_outcome: 'success', suggestion_reason: 'success_keyword' };

  return { suggested_outcome: 'unknown', suggestion_reason: 'no_signal' };
}

module.exports = { writeMemory, queryMemory, memoryStatus, recallMemory, markOutcome, buildContext, buildExecutionPrompt, classifyOutcome };
