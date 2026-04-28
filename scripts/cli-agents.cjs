#!/usr/bin/env node
/**
 * Mission Control Execution Guard
 * 
 * Enforces task requirement for agent execution.
 * 
 * Usage:
 *   node cli-agents.cjs run hermes --task <task_id> "prompt"
 *   node cli-agents.cjs run hermes "prompt"           # requires task to be created first
 *   node cli-agents.cjs task create "title"
 *   node cli-agents.cjs task status <task_id>
 */

const path = require('node:path');
const { spawn } = require('node:child_process');
const https = require('node:https');
const http = require('node:http');

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
// TASK MANAGEMENT
// ============================================================================

function createTask(title, options = {}) {
  try {
    const database = getDb();
    const stmt = database.prepare(`
      INSERT INTO tasks (title, description, status, created_at, updated_at)
      VALUES (?, ?, 'inbox', unixepoch(), unixepoch())
    `);
    const result = stmt.run(title, options.description || null);
    
    console.log(JSON.stringify({ 
      status: 'ok', 
      task_id: result.lastInsertRowid,
      title
    }));
    return result.lastInsertRowid;
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message }));
    return null;
  }
}

function getTask(taskId) {
  try {
    const database = getDb();
    const task = database.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    if (!task) {
      console.log(JSON.stringify({ status: 'error', message: 'Task not found' }));
      return null;
    }
    console.log(JSON.stringify({ status: 'ok', task }));
    return task;
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message }));
    return null;
  }
}

function listTasks(options = {}) {
  try {
    const database = getDb();
    const tasks = database.prepare(`
      SELECT id, title, status, created_at FROM tasks 
      ORDER BY created_at DESC LIMIT 20
    `).all();
    
    console.log(JSON.stringify({ status: 'ok', tasks }));
    return tasks;
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message }));
    return [];
  }
}

// ============================================================================
// AGENT EXECUTION WITH GUARD
// ============================================================================

function runHermes(prompt, options = {}) {
  const { taskId = null, agent = 'hermes' } = options;
  
  // GUARD: Require task ID — log all attempts (blocked or not) for audit trail
  const attemptedAt = Math.floor(Date.now() / 1000);
  try {
    const database = getDb();
    database.prepare(`
      INSERT OR IGNORE INTO tasks (title, status, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(
      `[AUDIT] agents run hermes — ${taskId ? 'task:' + taskId : 'NO TASK ID'} — ${new Date().toISOString()}`,
      taskId ? 'audit_with_task' : 'audit_blocked',
      attemptedAt, attemptedAt
    );
  } catch {}

  if (!taskId) {
    console.log(JSON.stringify({
      status: 'blocked',
      reason: 'Task ID required',
      message: 'Use: mc agents run hermes --task <task_id> "<prompt>"',
      hint: 'Or create task first: mc task create "title"'
    }));
    return { blocked: true };
  }
  
  // Verify task exists and is valid
  const task = getTask(taskId);
  if (!task) {
    console.log(JSON.stringify({ 
      status: 'blocked',
      reason: 'Invalid task ID',
      task_id: taskId
    }));
    return { blocked: true };
  }
  
  // Update task status
  try {
    const database = getDb();
    database.prepare(`
      UPDATE tasks SET status = 'in_progress', updated_at = unixepoch()
      WHERE id = ?
    `).run(taskId);
  } catch {}
  
  // Log execution start
  console.log(JSON.stringify({ 
    status: 'executing',
    agent,
    task_id: taskId,
    prompt: prompt.substring(0, 100)
  }));
  
  // Execute Hermes (simulated - would call actual Hermes CLI)
  // For now, just update task
  try {
    const database = getDb();
    database.prepare(`
      UPDATE tasks SET status = 'done', updated_at = unixepoch()
      WHERE id = ?
    `).run(taskId);
  } catch {}
  
  console.log(JSON.stringify({ 
    status: 'done',
    agent,
    task_id: taskId,
    message: 'Hermes execution complete (simulated)'
  }));
  
  return { success: true, taskId };
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
  const args = process.argv.slice(2);
  const command = args[0] || '';
  const subcommand = args[1] || '';
  
  if (command === 'task') {
    if (subcommand === 'create') {
      const title = args.slice(2).join(' ') || 'Untitled task';
      createTask(title);
    } else if (subcommand === 'list') {
      listTasks();
    } else if (subcommand === 'status') {
      const taskId = parseInt(args[2]);
      if (taskId) getTask(taskId);
      else console.log(JSON.stringify({ error: 'Task ID required' }));
    } else {
      console.log(JSON.stringify({ error: 'Unknown task command' }));
    }
  } else if (command === 'run') {
    const agent = subcommand;
    const taskIdx = args.indexOf('--task');
    const taskId = taskIdx > -1 ? args[taskIdx + 1] : null;
    const promptIdx = args.indexOf('"');
    const prompt = promptIdx > -1 ? args.slice(promptIdx).join(' ').replace(/"/g, '') : args.slice(2).join(' ');
    
    if (agent === 'hermes') {
      runHermes(prompt, { taskId, agent });
    } else {
      console.log(JSON.stringify({ error: `Unknown agent: ${agent}` }));
    }
  } else if (command === 'run' && !subcommand) {
    // mc agents run hermes "prompt" without task
    console.log(JSON.stringify({ 
      status: 'blocked',
      reason: 'Task ID required',
      message: 'Use: mc agents run hermes --task <task_id> "<prompt>"',
      hint: 'Create task first: mc task create "title"'
    }));
  } else {
    console.log(`Mission Control Agents CLI

Usage:
  mc agents run hermes --task <task_id> "<prompt>"  Execute Hermes with task guard
  mc task create "title"                       Create a task
  mc task list                                 List tasks
  mc task status <task_id>                    Get task details

Examples:
  mc task create "Cleanup memory"
  mc task list
  mc agents run hermes --task 1 "analyze logs"
`);
  }
  
  if (db) db.close();
}

main();