#!/usr/bin/env node
/**
 * Memory CLI - Direct integration with mc-memory-sync.cjs
 * 
 * Usage:
 *   node cli-memory.cjs status
 *   node cli-memory.cjs sync --dry-run
 *   node cli-memory.cjs sync --apply
 *   node cli-memory.cjs query "search term"
 */

const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');

const memoryService = require('./memory-service.cjs');

// ============================================================================
// CONFIG
// ============================================================================

const HOMEDIR = process.env.HOME || process.env.USERPROFILE || '';
const MISSION_CONTROL_DIR = path.join(HOMEDIR, 'mission-control');
const DB_PATH = path.join(MISSION_CONTROL_DIR, '.data', 'mission-control.db');

// ============================================================================
// DATABASE
// ============================================================================

let db = null;

function getDb() {
  if (!db) {
    const Database = require('better-sqlite3');
    db = new Database(DB_PATH);
  }
  return db;
}

// ============================================================================
// MEMORY STATUS
// ============================================================================

function memoryStatus() {
  try {
    const result = memoryService.memoryStatus();
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message }));
    return { status: 'error', message: e.message };
  }
}

// ============================================================================
// MEMORY SYNC
// ============================================================================

function memorySync(options = {}) {
  const { source = 'all', apply = false } = options;
  const hermesDir = path.join(HOMEDIR, '.hermes', 'memory_store');
  const claudeDir = path.join(HOMEDIR, '.claude');
  const codexDir = path.join(HOMEDIR, 'Documents', 'Codex');
  
  const records = [];
  
  // Hermes
  if (source === 'hermes' || source === 'all') {
    if (fs.existsSync(hermesDir)) {
      const historyDb = path.join(hermesDir, 'history.db');
      if (fs.existsSync(historyDb)) {
        try {
          const Database = require('better-sqlite3');
          const heresDb = new Database(historyDb, { readonly: true });
          const tables = heresDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
          for (const t of tables) {
            if (t.name.startsWith('sqlite_')) continue;
            const rows = heresDb.prepare(`SELECT * FROM ${t.name} LIMIT 10`).all();
            for (const row of rows) {
              records.push({
                source: 'hermes',
                source_ref: `history.db:${t.name}`,
                category: t.name,
                content: JSON.stringify(row).substring(0, 5000),
                tags: JSON.stringify([t.name])
              });
            }
          }
          heresDb.close();
        } catch {}
      }
    }
  }
  
  // Claude
  if (source === 'claude' || source === 'all') {
    const historyFile = path.join(claudeDir, 'history.jsonl');
    if (fs.existsSync(historyFile)) {
      try {
        const lines = fs.readFileSync(historyFile, 'utf-8').split('\n').slice(0, 100);
        let count = 0;
        for (const line of lines) {
          if (!line.trim() || count >= 50) continue;
          try {
            const entry = JSON.parse(line);
            records.push({
              source: 'claude-code',
              source_ref: historyFile,
              category: entry.role || 'general',
              content: (entry.content || '').substring(0, 2000),
              tags: JSON.stringify([entry.model].filter(Boolean))
            });
            count++;
          } catch {}
        }
      } catch {}
    }
  }
  
  // Codex
  if (source === 'codex' || source === 'all') {
    const stateFile = path.join(HOMEDIR, '.codex', '.codex-global-state.json');
    if (fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        records.push({
          source: 'codex',
          source_ref: stateFile,
          category: 'state',
          content: JSON.stringify(state).substring(0, 5000),
          tags: '["global-state"]'
        });
      } catch {}
    }
  }
  
  const result = {
    mode: apply ? 'apply' : 'dry-run',
    source,
    records_found: records.length
  };
  
  // Apply if requested
  if (apply && records.length > 0) {
    try {
      const database = getDb();
      database.exec(`
        CREATE TABLE IF NOT EXISTS memory_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source TEXT NOT NULL,
          source_ref TEXT,
          project TEXT,
          category TEXT NOT NULL DEFAULT 'general',
          content TEXT NOT NULL,
          confidence REAL DEFAULT 1.0,
          tags TEXT DEFAULT '[]',
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
      
      const stmt = database.prepare(`
        INSERT INTO memory_entries (source, source_ref, category, content, tags, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())
      `);
      
      let wrote = 0;
      for (const record of records) {
        try {
          stmt.run(record.source, record.source_ref, record.category, record.content, record.tags);
          wrote++;
        } catch {}
      }
      
      result.records_written = wrote;
    } catch (e) {
      result.error = e.message;
    }
  }
  
  console.log(JSON.stringify(result, null, 2));
  return result;
}

// ============================================================================
// MEMORY WRITE
// ============================================================================

function memoryWrite(source, category, content) {
  try {
    const result = memoryService.writeMemory(source, category, content);
    console.log(JSON.stringify({ status: 'ok', id: result.id }));
    return result;
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message }));
    return null;
  }
}

// ============================================================================
// MEMORY QUERY
// ============================================================================

function memoryQuery(searchTerm, filters = {}) {
  try {
    const rows = memoryService.queryMemory(searchTerm, filters);
    const result = {
      query: searchTerm,
      results: rows.length,
      records: rows.map(r => ({
        id: r.id,
        source: r.source,
        category: r.category,
        agent: r.agent,
        task_id: r.task_id,
        content_preview: r.content.substring(0, 200),
        created_at: r.created_at
      }))
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message }));
    return { status: 'error', message: e.message };
  }
}

// ============================================================================
// MEMORY OUTCOME
// ============================================================================

function memoryOutcome(id, outcome) {
  try {
    const result = memoryService.markOutcome(Number(id), outcome);
    console.log(JSON.stringify({ status: 'ok', ...result }));
    return result;
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message }));
    return null;
  }
}

// ============================================================================
// MEMORY REVIEW / APPROVE
// ============================================================================

function memoryReview(limit) {
  try {
    const entries = memoryService.getPendingOutcomes(Number(limit) || 20);
    console.log(JSON.stringify({ status: 'ok', pending: entries.length, entries }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message }));
  }
}

function memoryApprove(id) {
  try {
    const suggestion = memoryService.getOutcomeSuggestion(Number(id));
    if (!suggestion) {
      console.log(JSON.stringify({ status: 'error', reason: 'not found or not pending' }));
      return;
    }
    const result = memoryService.markOutcome(suggestion.id, suggestion.suggested_outcome);
    console.log(JSON.stringify({ status: 'ok', ...result, applied: suggestion.suggested_outcome }));
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message }));
  }
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';
  
  if (command === 'write') {
    const source = args[1] || 'unknown';
    const category = args[2] || 'general';
    const content = args.slice(3).join(' ');
    if (!content) {
      console.log(JSON.stringify({ error: 'Content required' }));
      process.exit(1);
    }
    memoryWrite(source, category, content);
  } else if (command === 'status') {
    memoryStatus();
  } else if (command === 'sync') {
    const source = args.includes('--source') ? args[args.indexOf('--source') + 1] : 'all';
    const apply = args.includes('--apply');
    memorySync({ source, apply });
  } else if (command === 'query') {
    const term = args[1] || '';
    if (!term) {
      console.log(JSON.stringify({ error: 'Query term required' }));
      process.exit(1);
    }
    const sourceIdx = args.indexOf('--source');
    const categoryIdx = args.indexOf('--category');
    const filters = {
      source: sourceIdx > -1 ? args[sourceIdx + 1] : null,
      category: categoryIdx > -1 ? args[categoryIdx + 1] : null,
    };
    memoryQuery(term, filters);
  } else if (command === 'outcome') {
    const id = args[1];
    const outcome = args[2];
    if (!id || !outcome) {
      console.log(JSON.stringify({ error: 'Usage: outcome <id> <success|failure|unknown>' }));
      process.exit(1);
    }
    memoryOutcome(id, outcome);
  } else if (command === 'review') {
    memoryReview(args[1]);
  } else if (command === 'approve') {
    const id = args[1];
    if (!id) {
      console.log(JSON.stringify({ error: 'Usage: approve <id>' }));
      process.exit(1);
    }
    memoryApprove(id);
  } else {
    console.log(JSON.stringify({ error: `Unknown command: ${command}` }));
    process.exit(1);
  }
  
  if (db) db.close();
}

main();