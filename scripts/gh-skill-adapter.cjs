#!/usr/bin/env node
/**
 * gh-skill-adapter.cjs — Convert gh skill preview SKILL.md output into a Mission Control skill entry.
 * Fully offline. Never calls gh, never makes network requests, never executes external code.
 *
 * Usage:
 *   node scripts/gh-skill-adapter.cjs <path-to-skill.md> [--name <name>] [--source <source>]
 *   node scripts/gh-skill-adapter.cjs --content "# My Skill\n..."
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Section heading → extracted_sections key mapping
const SECTION_MAP = [
  { patterns: ['guiding principle', 'principle'],  key: 'principles' },
  { patterns: ['workflow', 'process', 'approach'], key: 'workflow' },
  { patterns: ['your task', 'task'],               key: 'task_definition' },
];

// Keywords that raise risk_level
const RISK_SIGNALS = [
  { keywords: ['rm -rf', 'delete', 'drop table', 'format disk', 'wipe'], level: 3 },
  { keywords: ['execute', 'run command', 'shell', 'subprocess', 'eval statement'], level: 2 },
  { keywords: ['install', 'deploy', 'push', 'commit', 'write to file'], level: 1 },
];

// Keywords that indicate mc_compatibility
const MC_COMPAT_SIGNALS = [
  'agent', 'orchestrat', 'task', 'workflow', 'document', 'code', 'review',
  'monitor', 'log', 'report', 'analysis', 'output', 'json', 'cli',
];

function stripPreviewHeader(raw) {
  // gh skill preview prepends a directory tree before the markdown.
  // Find the first line starting with "# " (h1) and start there.
  const lines = raw.split('\n');
  const h1idx = lines.findIndex(l => /^#\s+/.test(l));
  return h1idx > 0 ? lines.slice(h1idx).join('\n') : raw;
}

function parseMarkdown(content) {
  const lines = content.split('\n');

  const titleLine = lines.find(l => /^#\s+/.test(l));
  const title = titleLine ? titleLine.replace(/^#\s+/, '').trim() : null;

  const sections = {};
  let currentHeading = null;
  let buffer = [];

  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (currentHeading !== null) {
        sections[currentHeading] = buffer.join('\n').trim();
      }
      currentHeading = line.replace(/^##\s+/, '').trim();
      buffer = [];
    } else if (currentHeading !== null) {
      buffer.push(line);
    }
  }
  if (currentHeading !== null) {
    sections[currentHeading] = buffer.join('\n').trim();
  }

  return { title, sections };
}

function mapExtractedSections(sections) {
  const result = { principles: null, workflow: null, task_definition: null };

  for (const [heading, body] of Object.entries(sections)) {
    const lower = heading.toLowerCase();
    for (const { patterns, key } of SECTION_MAP) {
      if (patterns.some(p => lower.includes(p))) {
        result[key] = body;
        break;
      }
    }
  }

  return result;
}

function classifyRisk(content) {
  const lower = content.toLowerCase();
  for (const { keywords, level } of RISK_SIGNALS) {
    if (keywords.some(k => lower.includes(k))) return level;
  }
  return 0;
}

function assessCompatibility(content) {
  const lower = content.toLowerCase();
  return MC_COMPAT_SIGNALS.some(s => lower.includes(s));
}

function adapt(raw, opts = {}) {
  const content = stripPreviewHeader(raw);
  const { title, sections } = parseMarkdown(content);
  const extracted = mapExtractedSections(sections);
  const risk = classifyRisk(content);
  const compat = assessCompatibility(content);

  const sectionKeys = Object.keys(sections);

  return {
    name: opts.name || (title ? title.toLowerCase().replace(/\s+/g, '-') : 'unknown'),
    source: opts.source || null,
    type: 'gh-skill',
    title: title || null,
    extracted_sections: extracted,
    all_sections: sectionKeys,
    risk_level: risk,
    mc_compatibility: compat,
    notes: `Parsed from SKILL.md. Sections found: ${sectionKeys.join(', ') || 'none'}.`,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const opts = { file: null, name: null, source: null, content: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name')    { opts.name = argv[++i]; continue; }
    if (argv[i] === '--source')  { opts.source = argv[++i]; continue; }
    if (argv[i] === '--content') { opts.content = argv[++i]; continue; }
    if (!argv[i].startsWith('--')) opts.file = argv[i];
  }
  return opts;
}

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log(JSON.stringify({
    status: 'error',
    message: 'Usage: node scripts/gh-skill-adapter.cjs <skill.md> [--name <name>] [--source <source>]',
  }));
  process.exit(1);
}

const opts = parseCliArgs(args);

let raw;
if (opts.content) {
  raw = opts.content;
} else if (opts.file) {
  try {
    raw = fs.readFileSync(path.resolve(opts.file), 'utf-8');
  } catch (e) {
    console.log(JSON.stringify({ status: 'error', message: `Cannot read file: ${e.message}` }));
    process.exit(1);
  }
} else {
  console.log(JSON.stringify({ status: 'error', message: 'Provide a file path or --content string.' }));
  process.exit(1);
}

const result = adapt(raw, { name: opts.name, source: opts.source });
console.log(JSON.stringify({ status: 'ok', skill: result }, null, 2));

module.exports = { adapt, parseMarkdown, mapExtractedSections, classifyRisk, assessCompatibility };
