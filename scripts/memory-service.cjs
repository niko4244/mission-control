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

module.exports = { writeMemory, queryMemory, memoryStatus };
