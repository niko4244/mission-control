#!/usr/bin/env node
/**
 * Memory Sync - Working Implementation
 * Connects Hermes/Claude/Codex memory to Mission Control
 * 
 * Usage:
 *   node scripts/mc-memory-sync.cjs hermes --dry-run
 *   node scripts/mc-memory-sync.cjs claude --dry-run
 *   node scripts/mc-memory-sync.cjs all --dry-run
 *   node scripts/mc-memory-sync.cjs all --apply
 */

const path = require('node:path');
const fs = require('node:fs');

// ============================================================================
// CONFIG
// ============================================================================

const HOMEDIR = process.env.HOME || process.env.USERPROFILE || '';
const MISSION_CONTROL_DIR = path.join(HOMEDIR, 'mission-control');
const DB_PATH = path.join(MISSION_CONTROL_DIR, '.data', 'mission-control.db');

// ============================================================================
// DATABASE (better-sqlite3)
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
// HERMES IMPORTER
// ============================================================================

async function importHermesMemory(options = {}) {
  const hermesDir = path.join(HOMEDIR, '.hermes', 'memory_store');
  const results = { source: 'hermes', records: [], wrote: 0, error: null };
  
  console.log(`[HERMES] Scanning: ${hermesDir}`);
  
  if (!fs.existsSync(hermesDir)) {
    results.error = 'Directory not found';
    return results;
  }
  
  // Read history.db (SQLite)
  const historyDb = path.join(hermesDir, 'history.db');
  if (fs.existsSync(historyDb)) {
    try {
      const Database = require('better-sqlite3');
      const heresDb = new Database(historyDb, { readonly: true });
      
      const tables = heresDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      for (const t of tables) {
        const tableName = t.name;
        if (tableName.startsWith('sqlite_')) continue;
        
        const rows = heresDb.prepare(`SELECT * FROM ${tableName} LIMIT 10`).all();
        for (const row of rows) {
          results.records.push({
            source: 'hermes',
            source_ref: `history.db:${tableName}`,
            category: tableName,
            content: JSON.stringify(row).substring(0, 5000),
            tags: JSON.stringify([tableName])
          });
        }
      }
      heresDb.close();
    } catch (e) {
      results.error = e.message;
    }
  }
  
  // Scan for JSON files
  const scanDir = (dir) => {
    try {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          scanDir(fullPath);
        } else if (item.endsWith('.json') && stat.size < 100000) {
          try {
            const content = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
            results.records.push({
              source: 'hermes',
              source_ref: fullPath,
              category: 'general',
              content: JSON.stringify(content).substring(0, 5000),
              tags: JSON.stringify([item])
            });
          } catch {
            // Skip invalid JSON
          }
        }
      }
    } catch {
      // Skip inaccessible directories
    }
  };
  
  scanDir(hermesDir);
  console.log(`[HERMES] Found: ${results.records.length} records`);
  
  if (options.apply && results.records.length > 0) {
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
      
      for (const record of results.records) {
        try {
          stmt.run(record.source, record.source_ref, record.category, record.content, record.tags);
          results.wrote++;
        } catch {
          // Skip failed inserts
        }
      }
      console.log(`[HERMES] Wrote: ${results.wrote} records to MC`);
    } catch (e) {
      results.error = e.message;
    }
  }
  
  return results;
}

// ============================================================================
// CLAUDE IMPORTER
// ============================================================================

async function importClaudeMemory(options = {}) {
  const claudeDir = path.join(HOMEDIR, '.claude');
  const results = { source: 'claude-code', records: [], wrote: 0, error: null };
  
  console.log(`[CLAUDE] Scanning: ${claudeDir}`);
  
  const historyFile = path.join(claudeDir, 'history.jsonl');
  if (fs.existsSync(historyFile)) {
    try {
      const lines = fs.readFileSync(historyFile, 'utf-8').split('\n').slice(0, 100);
      let count = 0;
      for (const line of lines) {
        if (!line.trim() || count >= 50) continue;
        try {
          const entry = JSON.parse(line);
          results.records.push({
            source: 'claude-code',
            source_ref: historyFile,
            category: entry.role || 'general',
            content: (entry.content || '').substring(0, 2000),
            tags: JSON.stringify([entry.model].filter(Boolean))
          });
          count++;
        } catch {
          // Skip invalid JSON
        }
      }
    } catch (e) {
      results.error = e.message;
    }
  }
  
  console.log(`[CLAUDE] Found: ${results.records.length} records`);
  
  if (options.apply && results.records.length > 0) {
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
      
      for (const record of results.records) {
        try {
          stmt.run(record.source, record.source_ref, record.category, record.content, record.tags);
          results.wrote++;
        } catch {
          // Skip failed inserts
        }
      }
      console.log(`[CLAUDE] Wrote: ${results.wrote} records to MC`);
    } catch (e) {
      results.error = e.message;
    }
  }
  
  return results;
}

// ============================================================================
// CODEX IMPORTER
// ============================================================================

async function importCodexMemory(options = {}) {
  const codexDir = path.join(HOMEDIR, 'Documents', 'Codex');
  const results = { source: 'codex', records: [], wrote: 0, error: null };
  
  console.log(`[CODEX] Scanning: ${codexDir}`);
  
  if (!fs.existsSync(codexDir)) {
    results.error = 'Directory not found';
    return results;
  }
  
  const stateFile = path.join(HOMEDIR, '.codex', '.codex-global-state.json');
  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      results.records.push({
        source: 'codex',
        source_ref: stateFile,
        category: 'state',
        content: JSON.stringify(state).substring(0, 5000),
        tags: '["global-state"]'
      });
    } catch (e) {
      results.error = e.message;
    }
  }
  
  console.log(`[CODEX] Found: ${results.records.length} records`);
  
  if (options.apply && results.records.length > 0) {
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
      
      for (const record of results.records) {
        try {
          stmt.run(record.source, record.source_ref, record.category, record.content, record.tags);
          results.wrote++;
        } catch {
          // Skip failed inserts
        }
      }
      console.log(`[CODEX] Wrote: ${results.wrote} records to MC`);
    } catch (e) {
      results.error = e.message;
    }
  }
  
  return results;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const source = args[0] || 'all';
  const apply = args.includes('--apply');
  const dryRun = !apply;
  
  console.log('========================================');
  console.log('Memory Sync - Mission Control');
  console.log(`Source: ${source}`);
  console.log(`Mode: ${dryRun ? 'DRY-RUN' : 'APPLY'}`);
  console.log('========================================\n');
  
  if (dryRun) {
    console.log('DRY-RUN MODE - No changes will be made');
    console.log('   Run with --apply to write to database\n');
  } else {
    console.log('APPLY MODE - Will write to Mission Control DB\n');
  }
  
  const results = [];
  
  if (source === 'hermes' || source === 'all') {
    results.push(await importHermesMemory({ apply }));
  }
  if (source === 'claude' || source === 'all') {
    results.push(await importClaudeMemory({ apply }));
  }
  if (source === 'codex' || source === 'all') {
    results.push(await importCodexMemory({ apply }));
  }
  
  console.log('\n========================================');
  console.log('SUMMARY');
  console.log('========================================');
  
  let totalFound = 0;
  let totalWrote = 0;
  for (const r of results) {
    console.log(`${r.source}: ${r.records.length} found${apply ? `, ${r.wrote} wrote` : ''}${r.error ? `, ERROR: ${r.error}` : ''}`);
    totalFound += r.records.length;
    totalWrote += r.wrote;
  }
  console.log(`\nTotal: ${totalFound} records found${apply ? `, ${totalWrote} written to MC` : ''}`);
  
  if (dryRun) {
    console.log('\nRun with --apply to write to database');
  } else {
    console.log('\nDone. Memory synced to Mission Control.');
  }
  
  if (db) db.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  if (db) db.close();
  process.exit(1);
});