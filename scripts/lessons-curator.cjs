#!/usr/bin/env node
/**
 * lessons-curator.cjs
 * Captures lessons, corrections, and durable operating patterns.
 *
 * OBSERVE ONLY / LESSONS KEEPER
 *
 * Persists to .data/lessons.jsonl
 *
 * Modes:
 *   status   — Count lessons by type, list recent 3
 *   add      — Append lesson: --title "X" --body "Y" [--type "pattern"] [--tags "t1,t2"] [--source "bot-id"]
 *   list     — Filter and return lessons [--type "correction"] [--severity "warn"]
 *   inspect  — Get single lesson by id: --id "les-xxx"
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const AGENT = 'Lessons Curator v1';
const LABEL = 'OBSERVE ONLY / LESSONS KEEPER';
const BOT_ID = 'lessons-curator';
const AUTHORITY = 'LESSONS_KEEPER';
const VALID_MODES = new Set(['status', 'add', 'list', 'inspect']);

const VALID_LESSON_TYPES = new Set(['correction', 'pattern', 'warning', 'postmortem']);
const VALID_SEVERITIES = new Set(['info', 'warn', 'critical']);

const DEFAULT_DATA_DIR = process.env.MISSION_CONTROL_DATA_DIR || '.data';
const LESSONS_FILENAME = 'lessons.jsonl';

function generateId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `les-${ts}-${rand}`;
}

function resolveLessonsPath(rootDir, options = {}) {
  if (options.lessonsPath) return path.resolve(options.lessonsPath);
  const dataDir = options.dataDir
    ? path.resolve(rootDir, options.dataDir)
    : path.resolve(rootDir, DEFAULT_DATA_DIR);
  return path.join(dataDir, LESSONS_FILENAME);
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function validateLesson(lesson) {
  const errors = [];
  if (!lesson || typeof lesson !== 'object' || Array.isArray(lesson)) {
    return ['Lesson must be a plain object'];
  }
  if (!lesson.id) errors.push('Missing required field: id');
  if (!lesson.timestamp) errors.push('Missing required field: timestamp');
  if (!lesson.source) errors.push('Missing required field: source');
  if (!lesson.lesson_type) errors.push('Missing required field: lesson_type');
  if (!lesson.title) errors.push('Missing required field: title');
  if (!lesson.body) errors.push('Missing required field: body');
  if (!lesson.severity) errors.push('Missing required field: severity');

  if (lesson.lesson_type && !VALID_LESSON_TYPES.has(lesson.lesson_type)) {
    errors.push(`Invalid lesson_type: "${lesson.lesson_type}". Valid: ${[...VALID_LESSON_TYPES].join(', ')}`);
  }
  if (lesson.severity && !VALID_SEVERITIES.has(lesson.severity)) {
    errors.push(`Invalid severity: "${lesson.severity}". Valid: ${[...VALID_SEVERITIES].join(', ')}`);
  }
  if (lesson.tags !== undefined && !Array.isArray(lesson.tags)) {
    errors.push('tags must be an array');
  }
  if (lesson.related_files !== undefined && !Array.isArray(lesson.related_files)) {
    errors.push('related_files must be an array');
  }
  return errors;
}

function buildLesson(partial, now = new Date()) {
  return {
    id: partial.id || generateId(),
    timestamp: partial.timestamp || now.toISOString(),
    source: String(partial.source || 'human'),
    lesson_type: String(partial.lesson_type || 'pattern'),
    title: String(partial.title || ''),
    body: String(partial.body || ''),
    tags: Array.isArray(partial.tags) ? partial.tags : [],
    related_files: Array.isArray(partial.related_files) ? partial.related_files : [],
    severity: String(partial.severity || 'info'),
  };
}

function appendLesson(lessonsPath, partial, options = {}) {
  const lesson = buildLesson(partial, options.now || new Date());
  const errors = validateLesson(lesson);
  if (errors.length > 0) {
    return { ok: false, errors, lesson: null };
  }
  ensureDir(lessonsPath);
  const line = JSON.stringify(lesson) + '\n';
  try {
    fs.appendFileSync(lessonsPath, line, 'utf8');
    return { ok: true, errors: [], lesson };
  } catch (error) {
    return {
      ok: false,
      errors: [`Failed to write lessons file: ${error instanceof Error ? error.message : String(error)}`],
      lesson,
    };
  }
}

function readLessons(lessonsPath, filter = {}) {
  if (!fs.existsSync(lessonsPath)) return [];
  let content;
  try {
    content = fs.readFileSync(lessonsPath, 'utf8');
  } catch {
    return [];
  }
  const lines = content.split('\n').filter(Boolean);
  const lessons = [];
  for (const line of lines) {
    try {
      lessons.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return lessons.filter((l) => {
    if (filter.lesson_type && l.lesson_type !== filter.lesson_type) return false;
    if (filter.severity && l.severity !== filter.severity) return false;
    if (filter.source && l.source !== filter.source) return false;
    return true;
  });
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const mode = VALID_MODES.has(String(args[0] || '').toLowerCase())
    ? String(args.shift()).toLowerCase()
    : 'status';
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (!current || !current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      options[key] = next;
      i += 1;
    } else {
      options[key] = true;
    }
  }
  return { mode, options };
}

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    authority: AUTHORITY,
    label: LABEL,
    mode,
    status: data.status || 'PASS',
    metadata: data.metadata || {},
    summary: data.summary || '',
  };
}

function buildStatusMode(rootDir, options = {}) {
  const lessonsPath = resolveLessonsPath(rootDir, options);
  const all = readLessons(lessonsPath);
  const byType = {};
  for (const l of all) {
    byType[l.lesson_type] = (byType[l.lesson_type] || 0) + 1;
  }
  const recent = all.slice(-3).reverse();
  const result = buildOutput('status', {
    status: 'PASS',
    metadata: {
      bot_id: BOT_ID,
      lessons_path: lessonsPath.replace(/\\/g, '/'),
      total: all.length,
      by_type: byType,
      recent: recent.map((l) => ({ id: l.id, title: l.title, lesson_type: l.lesson_type, severity: l.severity })),
    },
    summary: `${AGENT} (${LABEL}) | ${all.length} lessons total`,
  });
  result.summary = `${AGENT} (${LABEL}) | ${all.length} lessons total`;
  return result;
}

function buildAddMode(rootDir, partial, options = {}) {
  const lessonsPath = resolveLessonsPath(rootDir, options);
  if (!partial.title || !partial.body) {
    const result = buildOutput('add', {
      status: 'FAIL',
      metadata: { error: 'Missing required --title and/or --body' },
      summary: `${AGENT} | FAIL | Missing required fields`,
    });
    result.summary = `${AGENT} | FAIL | Missing required fields`;
    return result;
  }
  const writeResult = appendLesson(lessonsPath, partial, options);
  if (!writeResult.ok) {
    const result = buildOutput('add', {
      status: 'FAIL',
      metadata: { errors: writeResult.errors },
      summary: `${AGENT} | FAIL | ${writeResult.errors[0]}`,
    });
    result.summary = `${AGENT} | FAIL | ${writeResult.errors[0]}`;
    return result;
  }
  const result = buildOutput('add', {
    status: 'PASS',
    metadata: { lesson: writeResult.lesson, lessons_path: lessonsPath.replace(/\\/g, '/') },
    summary: `${AGENT} | PASS | Lesson ${writeResult.lesson.id} added`,
  });
  result.summary = `${AGENT} | PASS | Lesson ${writeResult.lesson.id} added`;
  return result;
}

function buildListMode(rootDir, filter, options = {}) {
  const lessonsPath = resolveLessonsPath(rootDir, options);
  const lessons = readLessons(lessonsPath, filter);
  const result = buildOutput('list', {
    status: 'PASS',
    metadata: { filter, count: lessons.length, lessons },
    summary: `${AGENT} | list | ${lessons.length} lessons matched`,
  });
  result.summary = `${AGENT} | list | ${lessons.length} lessons matched`;
  return result;
}

function buildInspectMode(rootDir, id, options = {}) {
  const lessonsPath = resolveLessonsPath(rootDir, options);
  if (!id) {
    const result = buildOutput('inspect', {
      status: 'FAIL',
      metadata: { error: 'Missing required --id' },
      summary: `${AGENT} | FAIL | Missing --id`,
    });
    result.summary = `${AGENT} | FAIL | Missing --id`;
    return result;
  }
  const all = readLessons(lessonsPath);
  const lesson = all.find((l) => l.id === id) || null;
  const result = buildOutput('inspect', {
    status: lesson ? 'PASS' : 'FAIL',
    metadata: { id, lesson },
    summary: lesson ? `${AGENT} | PASS | Found lesson ${id}` : `${AGENT} | FAIL | Lesson ${id} not found`,
  });
  result.summary = lesson ? `${AGENT} | PASS | Found lesson ${id}` : `${AGENT} | FAIL | Lesson ${id} not found`;
  return result;
}

function formatOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

  if (parsed.mode === 'add') {
    const tagsRaw = parsed.options.tags;
    const tags = tagsRaw ? String(tagsRaw).split(',').map((t) => t.trim()).filter(Boolean) : [];
    const partial = {
      title: parsed.options.title || '',
      body: parsed.options.body || '',
      lesson_type: parsed.options.type || 'pattern',
      source: parsed.options.source || 'human',
      severity: parsed.options.severity || 'info',
      tags,
    };
    return buildAddMode(rootDir, partial, options);
  }
  if (parsed.mode === 'list') {
    const filter = {};
    if (parsed.options.type) filter.lesson_type = parsed.options.type;
    if (parsed.options.severity) filter.severity = parsed.options.severity;
    if (parsed.options.source) filter.source = parsed.options.source;
    return buildListMode(rootDir, filter, options);
  }
  if (parsed.mode === 'inspect') {
    return buildInspectMode(rootDir, parsed.options.id || '', options);
  }
  return buildStatusMode(rootDir, options);
}

module.exports = {
  AGENT,
  AUTHORITY,
  LABEL,
  BOT_ID,
  VALID_LESSON_TYPES,
  VALID_SEVERITIES,
  appendLesson,
  buildAddMode,
  buildInspectMode,
  buildLesson,
  buildListMode,
  buildOutput,
  buildStatusMode,
  formatOutput,
  generateId,
  main,
  parseArgs,
  readLessons,
  resolveLessonsPath,
  validateLesson,
};

if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(formatOutput(result));
  } catch (error) {
    process.stderr.write(JSON.stringify({
      agent: AGENT,
      label: LABEL,
      status: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
    }, null, 2) + '\n');
    process.exit(1);
  }
}
