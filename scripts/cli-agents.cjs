#!/usr/bin/env node
/**
 * Mission Control Execution Guard
 */

const path = require('node:path');
const memoryService = require('./memory-service.cjs');


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

function listTasks() {
  try {
    const database = getDb();
    const tasks = database.prepare(`
      SELECT id, title, status, created_at
      FROM tasks
      ORDER BY created_at DESC
      LIMIT 20
    `).all();

    console.log(JSON.stringify({ status: 'ok', tasks }));
    return tasks;
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: e.message }));
    return [];
  }
}

function runHermes(prompt, options = {}) {
  const { taskId = null, agent = 'hermes' } = options;

  const attemptedAt = Math.floor(Date.now() / 1000);

  try {
    const database = getDb();
    database.prepare(`
      INSERT OR IGNORE INTO tasks (title, status, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(
      `[AUDIT] agents run hermes — ${taskId ? 'task:' + taskId : 'NO TASK ID'} — ${new Date().toISOString()}`,
      taskId ? 'audit_with_task' : 'audit_blocked',
      attemptedAt,
      attemptedAt
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

  const task = getTask(taskId);

  if (!task) {
    console.log(JSON.stringify({
      status: 'blocked',
      reason: 'Invalid task ID',
      task_id: taskId
    }));

    return { blocked: true };
  }

  try {
    const database = getDb();
    database.prepare(`
      UPDATE tasks
      SET status = 'in_progress', updated_at = unixepoch()
      WHERE id = ?
    `).run(taskId);
  } catch {}

  const recall = memoryService.recallMemory('hermes', taskId, prompt);

  const context = {
    successfulPatterns: recall.filter(e => (e.tags || '').includes('outcome:success')),
    failedPatterns:     recall.filter(e => (e.tags || '').includes('outcome:failure')),
    neutralContext:     recall.filter(e => !(e.tags || '').includes('outcome:success') && !(e.tags || '').includes('outcome:failure')),
  };
  const hasSuccess = context.successfulPatterns.length > 0;
  const hasFailure = context.failedPatterns.length > 0;

  console.log(JSON.stringify({
    status: 'executing',
    agent,
    task_id: taskId,
    prompt: String(prompt || '').substring(0, 100),
    recall_count: recall.length,
    context_summary: {
      successful: context.successfulPatterns.length,
      failed:     context.failedPatterns.length,
      neutral:    context.neutralContext.length,
    },
    decision_hint: hasSuccess ? 'bias_to_success'
      : hasFailure ? 'avoid_failure_pattern'
      : 'no_prior_signal',
  }));

  try {
    const database = getDb();
    database.prepare(`
      UPDATE tasks
      SET status = 'done', updated_at = unixepoch()
      WHERE id = ?
    `).run(taskId);
  } catch {}

  console.log(JSON.stringify({
    status: 'done',
    agent,
    task_id: taskId,
    message: 'Hermes execution complete (simulated)'
  }));

  try {
    memoryService.writeMemory('hermes', 'execution', prompt || 'no prompt', {
      taskId: taskId ? Number(taskId) : null,
      agent: 'hermes',
      runId: `hermes-${taskId}-${Date.now()}`,
      tags: 'execution,hermes,mission-control,outcome:unknown',
      confidence: 1,
      sourceRef: `recall:${recall.length}`,
    });
    console.log('memory entry created');
  } catch (err) {
    console.error('memory write failed:', err.message);
  }
  return { success: true, taskId };
}

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
      const taskId = parseInt(args[2], 10);
      if (taskId) getTask(taskId);
      else console.log(JSON.stringify({ error: 'Task ID required' }));
    } else {
      console.log(JSON.stringify({ error: 'Unknown task command' }));
    }
  } else if (command === 'run') {
    const agent = subcommand;
    const taskIdx = args.indexOf('--task');
    const taskId = taskIdx > -1 ? args[taskIdx + 1] : null;

    let promptArgs = args.slice(2);

    if (taskIdx > -1) {
      promptArgs = args.slice(taskIdx + 2);
    }

    const prompt = promptArgs.join(' ');

    if (agent === 'hermes') {
      runHermes(prompt, { taskId, agent });
    } else {
      console.log(JSON.stringify({ error: `Unknown agent: ${agent}` }));
    }
  } else {
    console.log(`Mission Control Agents CLI

Usage:
  mc agents run hermes --task <task_id> "<prompt>"
  mc task create "title"
  mc task list
  mc task status <task_id>
`);
  }

  setTimeout(() => {
    if (db) db.close();
  }, 250);
}

main();

