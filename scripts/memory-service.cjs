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

function writeMemory(source, category, content) {
  const database = getDb();
  const result = database.prepare(`
    INSERT INTO memory_entries (source, category, content, created_at, updated_at)
    VALUES (?, ?, ?, unixepoch(), unixepoch())
  `).run(source, category, content);
  return { id: result.lastInsertRowid };
}

function queryMemory(searchTerm) {
  const database = getDb();
  return database.prepare(`
    SELECT * FROM memory_entries
    WHERE content LIKE ? OR tags LIKE ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(`%${searchTerm}%`, `%${searchTerm}%`);
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
