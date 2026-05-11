#!/usr/bin/env node
/**
 * risk-scoring-engine.cjs
 * Observe-only composite risk scorer for Mission Control change sets.
 */

'use strict';

const path = require('node:path');

const AGENT = 'Risk Scoring Engine v1';
const LABEL = 'OBSERVE ONLY / RISK CLASSIFIER';
const VALID_MODES = new Set(['status', 'score']);

// File pattern weights
const FILE_PATTERNS = [
  { test: (f) => /^(src\/lib\/)?auth\//.test(f) || /^(src\/lib\/)?security\//.test(f) || f.includes('/auth/') || f.includes('/security/'), weight: 40, label: 'auth/security file' },
  { test: (f) => /^src\/app\/api\//.test(f), weight: 25, label: 'API route' },
  { test: (f) => f === 'package.json' || f === 'pnpm-lock.yaml', weight: 35, label: 'package/lockfile' },
  { test: (f) => /^config\/.*\.json$/.test(f), weight: 30, label: 'governance config' },
  { test: (f) => /^scripts\/.*\.cjs$/.test(f), weight: 20, label: 'script file' },
  { test: (f) => /^src\/lib\//.test(f) && !/\.(test|spec)\.(ts|js|tsx|jsx)$/.test(f), weight: 15, label: 'lib source' },
  { test: (f) => /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(f) || /__tests__\//.test(f), weight: 5, label: 'test file' },
  { test: (f) => /^docs\//.test(f) || /\.md$/.test(f), weight: 3, label: 'docs file' },
];

// Command risk modifiers
const COMMAND_RISKS = [
  { pattern: 'git push --force', delta: 80, label: 'force push' },
  { pattern: 'rm -rf', delta: 80, label: 'recursive delete' },
  { pattern: 'git add .', delta: 60, label: 'git add all' },
  { pattern: 'git push', delta: 50, label: 'git push' },
  { pattern: 'git merge', delta: 50, label: 'git merge' },
  { pattern: 'pnpm test', delta: -10, label: 'test validation (reduces risk)' },
  { pattern: 'pnpm typecheck', delta: -5, label: 'typecheck validation (reduces risk)' },
];

// Domain multipliers
const DOMAIN_MULTIPLIERS = {
  auth: 1.8,
  security: 1.5,
  release: 1.3,
  governance: 1.2,
  docs: 0.5,
};

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function parseArgs(argv = process.argv.slice(2)) {
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
    if (nextValue && !nextValue.startsWith('--')) {
      options[key] = nextValue;
      index += 1;
    } else {
      options[key] = true;
    }
  }

  return { mode, options };
}

function classifyFiles(files) {
  const normalized = (files || []).map(normalizePath);

  const isTestOnly = normalized.length > 0 && normalized.every(
    (f) => /\.(test|spec)\.(ts|js|tsx|jsx)$/.test(f) || /__tests__\//.test(f)
  );
  const isDocsOnly = normalized.length > 0 && normalized.every(
    (f) => /^docs\//.test(f) || /\.md$/.test(f)
  );

  return { isTestOnly, isDocsOnly };
}

function scoreRisk(files, commands, domain) {
  const normalizedFiles = (files || []).map(normalizePath);
  const normalizedCommands = (commands || []);
  const factors = [];

  // --- File risk ---
  let fileRisk = 0;
  for (const file of normalizedFiles) {
    for (const pattern of FILE_PATTERNS) {
      if (pattern.test(file)) {
        fileRisk += pattern.weight;
        factors.push({
          name: `file:${file}`,
          contribution: pattern.weight,
          reason: pattern.label,
        });
        break; // only apply highest-matching pattern per file
      }
    }
  }

  // --- Command risk ---
  let commandRisk = 0;
  for (const cmd of normalizedCommands) {
    for (const cr of COMMAND_RISKS) {
      if (String(cmd).includes(cr.pattern)) {
        commandRisk += cr.delta;
        factors.push({
          name: `command:${cmd}`,
          contribution: cr.delta,
          reason: cr.label,
        });
        break;
      }
    }
  }

  // --- Breadth penalty ---
  let breadthPenalty = 0;
  if (normalizedFiles.length > 50) {
    breadthPenalty = 60;
    factors.push({ name: 'breadth:>50files', contribution: 60, reason: 'More than 50 files touched' });
  } else if (normalizedFiles.length > 20) {
    breadthPenalty = 40;
    factors.push({ name: 'breadth:>20files', contribution: 40, reason: 'More than 20 files touched' });
  } else if (normalizedFiles.length > 8) {
    breadthPenalty = 20;
    factors.push({ name: 'breadth:>8files', contribution: 20, reason: 'More than 8 files touched' });
  }

  // --- Raw score before domain multiplier ---
  const rawScore = fileRisk + commandRisk + breadthPenalty;

  // --- Domain multiplier ---
  const domainKey = String(domain || '').toLowerCase();
  const multiplier = DOMAIN_MULTIPLIERS[domainKey] || 1.0;
  if (multiplier !== 1.0) {
    factors.push({
      name: `domain:${domainKey}`,
      contribution: Math.round((multiplier - 1.0) * rawScore),
      reason: `Domain multiplier ${multiplier}x`,
    });
  }

  // Clamp to 0-100
  const risk_score = Math.min(100, Math.max(0, Math.round(rawScore * multiplier)));

  // --- Risk class ---
  const { isTestOnly, isDocsOnly } = classifyFiles(normalizedFiles);

  let risk_class;
  if (risk_score >= 71) {
    risk_class = 'Critical';
  } else if (risk_score >= 41) {
    risk_class = 'High';
  } else if (risk_score >= 21) {
    risk_class = 'Medium';
  } else {
    // Low range — contextual sub-classes
    if (isTestOnly) {
      risk_class = 'TestOnly';
    } else if (isDocsOnly) {
      risk_class = 'Docs';
    } else if (normalizedFiles.every((f) => /^scripts\//.test(f) || /^config\//.test(f))) {
      risk_class = 'Tooling';
    } else {
      risk_class = 'Low';
    }
  }

  // --- Blast radius ---
  let blast_radius;
  if (risk_score >= 71) {
    blast_radius = 'broad';
  } else if (risk_score >= 41) {
    blast_radius = 'significant';
  } else if (risk_score >= 21) {
    blast_radius = 'contained';
  } else {
    blast_radius = 'minimal';
  }

  const escalation_required = risk_class === 'Critical' || risk_class === 'High';

  return {
    risk_class,
    risk_score,
    factors,
    blast_radius,
    escalation_required,
    breakdown: {
      file_risk: fileRisk,
      command_risk: commandRisk,
      domain_risk: Math.round(rawScore * multiplier) - rawScore,
      breadth_penalty: breadthPenalty,
    },
  };
}

function buildScoreMode(files, commands, domain) {
  const parsed = scoreRisk(files, commands, domain);
  return {
    agent: AGENT,
    label: LABEL,
    mode: 'score',
    status: 'PASS',
    ...parsed,
    summary: buildScoreSummary(parsed),
  };
}

function buildScoreSummary(result) {
  return [
    `${AGENT} (${LABEL})`,
    `Mode: score`,
    `Risk class: ${result.risk_class}`,
    `Risk score: ${result.risk_score}/100`,
    `Blast radius: ${result.blast_radius}`,
    `Escalation required: ${result.escalation_required}`,
  ].join('\n');
}

function buildStatusOutput() {
  return {
    agent: AGENT,
    label: LABEL,
    mode: 'status',
    status: 'PASS',
    observe_only: true,
    description: 'Calculates a composite risk score from files touched, commands planned, domain context, and blast radius indicators.',
    scoring_factors: {
      file_weights: FILE_PATTERNS.map((p) => ({ label: p.label, weight: p.weight })),
      command_modifiers: COMMAND_RISKS.map((c) => ({ pattern: c.pattern, delta: c.delta, label: c.label })),
      domain_multipliers: DOMAIN_MULTIPLIERS,
      breadth_thresholds: [
        { files_gt: 8, penalty: 20 },
        { files_gt: 20, penalty: 40 },
        { files_gt: 50, penalty: 60 },
      ],
    },
    risk_class_thresholds: {
      Critical: '71-100',
      High: '41-70',
      Medium: '21-40',
      Low_or_contextual: '0-20',
    },
    summary: `${AGENT} (${LABEL})\nMode: status\nStatus: PASS`,
  };
}

function buildOutput(result) {
  return `${JSON.stringify(result, null, 2)}\n\n${result.summary}\n`;
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);

  if (parsed.mode === 'score') {
    let files = [];
    let commands = [];
    const domain = parsed.options.domain || '';

    try {
      files = parsed.options.files ? JSON.parse(parsed.options.files) : [];
    } catch {
      files = [];
    }
    try {
      commands = parsed.options.commands ? JSON.parse(parsed.options.commands) : [];
    } catch {
      commands = [];
    }

    return buildScoreMode(files, commands, domain);
  }

  return buildStatusOutput();
}

module.exports = {
  AGENT,
  LABEL,
  FILE_PATTERNS,
  COMMAND_RISKS,
  DOMAIN_MULTIPLIERS,
  scoreRisk,
  buildScoreMode,
  buildOutput,
  buildStatusOutput,
  main,
  normalizePath,
  parseArgs,
};

if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
