#!/usr/bin/env node
/**
 * backlog-reconciler.cjs
 * Observe-only backlog manager. Converts raw ideas and feature descriptions
 * into structured, prioritized implementation backlog items.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const AGENT = 'Backlog Reconciler v1';
const LABEL = 'OBSERVE ONLY / BACKLOG MANAGER';
const VALID_MODES = new Set(['status', 'list', 'add', 'prioritize']);

const VALID_CATEGORIES = ['governance', 'security', 'ui', 'testing', 'documentation', 'infrastructure', 'feature'];
const VALID_RISK_LEVELS = ['Critical', 'High', 'Medium', 'Low', 'Tooling', 'Docs'];
const VALID_STATUSES = ['new', 'planned', 'in_progress', 'done', 'blocked', 'deferred'];
const VALID_COMPLEXITIES = ['trivial', 'small', 'medium', 'large'];
const VALID_SOURCES = ['manual', 'steward', 'pr_comment', 'todo_marker'];

const CATEGORY_ORDER = ['governance', 'security', 'infrastructure', 'testing', 'ui', 'documentation', 'feature'];
const RISK_ORDER = ['Critical', 'High', 'Medium', 'Low', 'Tooling', 'Docs'];
const COMPLEXITY_ORDER = ['trivial', 'small', 'medium', 'large'];

function getDataDir() {
  return process.env.MISSION_CONTROL_DATA_DIR || '.data';
}

function getBacklogFilePath(dataDir) {
  return path.join(dataDir, 'backlog-items.json');
}

function ensureDataDir(dataDir) {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function loadItems(dataDir) {
  const filePath = getBacklogFilePath(dataDir);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveItems(items, dataDir) {
  ensureDataDir(dataDir);
  const filePath = getBacklogFilePath(dataDir);
  fs.writeFileSync(filePath, JSON.stringify(items, null, 2) + '\n', 'utf8');
}

function generateId() {
  const ts = Date.now().toString(36);
  const hash = crypto.randomBytes(4).toString('hex');
  return `bl-${ts}-${hash}`;
}

function createItem(fields) {
  const now = new Date().toISOString();
  return {
    id: fields.id || generateId(),
    title: String(fields.title || ''),
    description: String(fields.description || ''),
    source: VALID_SOURCES.includes(fields.source) ? fields.source : 'manual',
    category: VALID_CATEGORIES.includes(fields.category) ? fields.category : 'feature',
    risk_level: VALID_RISK_LEVELS.includes(fields.risk_level) ? fields.risk_level : 'Medium',
    status: VALID_STATUSES.includes(fields.status) ? fields.status : 'new',
    priority: typeof fields.priority === 'number' && fields.priority >= 1 && fields.priority <= 5
      ? fields.priority
      : 3,
    autonomous_safe: typeof fields.autonomous_safe === 'boolean' ? fields.autonomous_safe : false,
    requires_governor_or_arbiter: typeof fields.requires_governor_or_arbiter === 'boolean'
      ? fields.requires_governor_or_arbiter
      : true,
    likely_files: Array.isArray(fields.likely_files) ? fields.likely_files : [],
    estimated_complexity: VALID_COMPLEXITIES.includes(fields.estimated_complexity)
      ? fields.estimated_complexity
      : 'medium',
    created_at: fields.created_at || now,
    updated_at: fields.updated_at || now,
    notes: String(fields.notes || ''),
  };
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const mode = VALID_MODES.has(String(args[0] || '').toLowerCase())
    ? String(args.shift()).toLowerCase()
    : 'status';
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current || !current.startsWith('--')) continue;
    const key = current.slice(2);
    const nextValue = args[index + 1];
    if (nextValue !== undefined && !nextValue.startsWith('--')) {
      options[key] = nextValue;
      index += 1;
    } else {
      options[key] = true;
    }
  }

  return { mode, options };
}

function countByField(items, field) {
  const counts = {};
  for (const item of items) {
    const value = item[field] || 'unknown';
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function buildStatusMode(dataDir) {
  const dir = dataDir || getDataDir();
  const items = loadItems(dir);
  const byStatus = countByField(items, 'status');
  const byCategory = countByField(items, 'category');

  return {
    agent: AGENT,
    label: LABEL,
    mode: 'status',
    status: 'PASS',
    total: items.length,
    by_status: byStatus,
    by_category: byCategory,
    data_file: getBacklogFilePath(dir),
    summary: [
      `${AGENT} (${LABEL})`,
      'Mode: status',
      `Total backlog items: ${items.length}`,
      `By status: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
      `By category: ${Object.entries(byCategory).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
    ].join('\n'),
  };
}

function buildListMode(dataDir, options) {
  const dir = dataDir || getDataDir();
  const items = loadItems(dir);
  const statusFilter = options && options.status ? String(options.status) : null;
  const categoryFilter = options && options.category ? String(options.category) : null;

  let filtered = items.slice();

  if (statusFilter) {
    filtered = filtered.filter((item) => item.status === statusFilter);
  }
  if (categoryFilter) {
    filtered = filtered.filter((item) => item.category === categoryFilter);
  }

  filtered.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  return {
    agent: AGENT,
    label: LABEL,
    mode: 'list',
    status: 'PASS',
    filters: { status: statusFilter, category: categoryFilter },
    count: filtered.length,
    items: filtered,
    summary: [
      `${AGENT} (${LABEL})`,
      'Mode: list',
      `Items returned: ${filtered.length}`,
    ].join('\n'),
  };
}

function buildAddMode(dataDir, options) {
  const dir = dataDir || getDataDir();

  if (!options || !options.title) {
    return {
      agent: AGENT,
      label: LABEL,
      mode: 'add',
      status: 'FAIL',
      error: 'Missing required --title option',
      summary: `${AGENT} (${LABEL})\nMode: add\nStatus: FAIL\nMissing required --title`,
    };
  }

  if (!options.description) {
    return {
      agent: AGENT,
      label: LABEL,
      mode: 'add',
      status: 'FAIL',
      error: 'Missing required --description option',
      summary: `${AGENT} (${LABEL})\nMode: add\nStatus: FAIL\nMissing required --description`,
    };
  }

  const priorityRaw = options.priority !== undefined ? Number(options.priority) : 3;
  const priority = Number.isFinite(priorityRaw) && priorityRaw >= 1 && priorityRaw <= 5
    ? priorityRaw
    : 3;

  const item = createItem({
    title: options.title,
    description: options.description,
    source: options.source || 'manual',
    category: options.category || 'feature',
    risk_level: options.risk || 'Medium',
    status: 'new',
    priority,
    autonomous_safe: false,
    requires_governor_or_arbiter: true,
    likely_files: [],
    estimated_complexity: options.complexity || 'medium',
    notes: options.notes || '',
  });

  const items = loadItems(dir);
  items.push(item);
  saveItems(items, dir);

  return {
    agent: AGENT,
    label: LABEL,
    mode: 'add',
    status: 'PASS',
    item,
    summary: [
      `${AGENT} (${LABEL})`,
      'Mode: add',
      `Status: PASS`,
      `Created: ${item.id} - ${item.title}`,
    ].join('\n'),
  };
}

function prioritizeItems(items) {
  return items.slice().sort((a, b) => {
    const catA = CATEGORY_ORDER.indexOf(a.category);
    const catB = CATEGORY_ORDER.indexOf(b.category);
    if (catA !== catB) return catA - catB;

    const riskA = RISK_ORDER.indexOf(a.risk_level);
    const riskB = RISK_ORDER.indexOf(b.risk_level);
    if (riskA !== riskB) return riskA - riskB;

    const compA = COMPLEXITY_ORDER.indexOf(a.estimated_complexity);
    const compB = COMPLEXITY_ORDER.indexOf(b.estimated_complexity);
    if (compA !== compB) return compA - compB;

    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  }).map((item, index) => ({
    ...item,
    priority: Math.min(5, Math.floor(index / Math.max(1, Math.ceil(items.length / 5))) + 1),
    updated_at: new Date().toISOString(),
  }));
}

function buildPrioritizeMode(dataDir) {
  const dir = dataDir || getDataDir();
  const items = loadItems(dir);

  if (items.length === 0) {
    return {
      agent: AGENT,
      label: LABEL,
      mode: 'prioritize',
      status: 'PASS',
      reranked: 0,
      items: [],
      summary: `${AGENT} (${LABEL})\nMode: prioritize\nNo items to re-rank`,
    };
  }

  const reranked = prioritizeItems(items);
  saveItems(reranked, dir);

  return {
    agent: AGENT,
    label: LABEL,
    mode: 'prioritize',
    status: 'PASS',
    reranked: reranked.length,
    items: reranked,
    summary: [
      `${AGENT} (${LABEL})`,
      'Mode: prioritize',
      `Status: PASS`,
      `Re-ranked ${reranked.length} items`,
    ].join('\n'),
  };
}

function main(argv, options) {
  const args = argv || process.argv.slice(2);
  const opts = options || {};
  const parsed = parseArgs(args);
  const dataDir = opts.dataDir || getDataDir();

  if (parsed.mode === 'list') {
    return buildListMode(dataDir, parsed.options);
  }
  if (parsed.mode === 'add') {
    return buildAddMode(dataDir, parsed.options);
  }
  if (parsed.mode === 'prioritize') {
    return buildPrioritizeMode(dataDir);
  }
  return buildStatusMode(dataDir);
}

module.exports = {
  AGENT,
  LABEL,
  VALID_CATEGORIES,
  VALID_RISK_LEVELS,
  VALID_STATUSES,
  VALID_COMPLEXITIES,
  VALID_SOURCES,
  CATEGORY_ORDER,
  RISK_ORDER,
  buildAddMode,
  buildListMode,
  buildPrioritizeMode,
  buildStatusMode,
  createItem,
  generateId,
  getBacklogFilePath,
  getDataDir,
  loadItems,
  main,
  parseArgs,
  prioritizeItems,
  saveItems,
};

if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`);
  } catch (error) {
    process.stderr.write(JSON.stringify({
      agent: AGENT,
      label: LABEL,
      mode: 'status',
      status: 'FAIL',
      error: error && error.message ? error.message : String(error),
    }, null, 2) + '\n');
    process.exit(1);
  }
}
