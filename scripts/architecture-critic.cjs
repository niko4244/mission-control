#!/usr/bin/env node
/**
 * architecture-critic.cjs
 * Detects architecture drift, import boundary violations, and refactor risk.
 *
 * OBSERVE ONLY / DRIFT DETECTOR
 * Read-only scanner. Never mutates files, git state, or remote systems.
 *
 * Modes:
 *   status              — Agent identity
 *   scan [--dir "…"]    — Scan directory for architecture issues
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'Architecture Critic v1';
const LABEL = 'OBSERVE ONLY / DRIFT DETECTOR';
const BOT_ID = 'architecture-critic';
const AUTHORITY_LEVEL = 4;
const VALID_MODES = new Set(['status', 'scan']);

const MAX_SCAN_FILES = 200;
const MAX_FILE_LINES = 500;
const MAX_ROUTE_HANDLER_LINES = 50;
const MAX_IMPORT_DEPTH = 4;
const LINES_TO_READ = 50;

const CROSS_BOUNDARY_PATTERNS = [
  { pattern: /^src\/app\//, forbidden: /from ['"].*scripts\//, rule: 'src/app/ imports scripts/' },
  { pattern: /^src\/components\//, forbidden: /from ['"].*src\/app\/api\//, rule: 'src/components/ imports src/app/api/' },
  { pattern: /^scripts\//, forbidden: /require\(['"].*\/src\/|from ['"].*\/src\//, rule: 'scripts/ imports src/' },
];

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const rawMode = String(args[0] || '').toLowerCase().replace(/^--/, '');
  const mode = VALID_MODES.has(rawMode) ? args.shift().toLowerCase().replace(/^--/, '') : 'status';
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (!current || !current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next;
      i += 1;
    } else {
      options[key] = true;
    }
  }
  return { mode, options };
}

function countImportDepth(importPath) {
  const normalized = normalizePath(importPath);
  // Count how many levels deep — e.g. ../../../../lib/foo = 4 levels
  const upCount = (normalized.match(/\.\.\//g) || []).length;
  return upCount;
}

function detectImportViolations(filePath, lines) {
  const violations = [];
  const normalizedFile = normalizePath(filePath);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNum = i + 1;

    // Check deep import chains
    const importMatch = line.match(/(?:from|require)\s*['"]([^'"]+)['"]/);
    if (importMatch) {
      const importPath = importMatch[1];
      const depth = countImportDepth(importPath);
      if (depth > MAX_IMPORT_DEPTH) {
        violations.push({
          file: normalizedFile,
          type: 'deep_import_chain',
          severity: 'medium',
          line: lineNum,
          description: `Deep import chain (${depth} levels): ${importPath}`,
        });
      }
    }

    // Check cross-boundary imports
    for (const rule of CROSS_BOUNDARY_PATTERNS) {
      if (rule.pattern.test(normalizedFile) && rule.forbidden.test(line)) {
        violations.push({
          file: normalizedFile,
          type: 'cross_boundary_import',
          severity: 'high',
          line: lineNum,
          description: `Boundary violation: ${rule.rule}`,
        });
      }
    }
  }

  return violations;
}

function scanDirectory(dirPath, rootDir) {
  const issues = [];
  const scannedFiles = [];

  function collectFiles(currentDir) {
    if (scannedFiles.length >= MAX_SCAN_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scannedFiles.length >= MAX_SCAN_FILES) break;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // Skip node_modules and .next
        if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') continue;
        collectFiles(fullPath);
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
        scannedFiles.push(fullPath);
      }
    }
  }

  const absoluteDir = path.isAbsolute(dirPath) ? dirPath : path.join(rootDir, dirPath);
  if (!fs.existsSync(absoluteDir)) {
    return { issues, files_scanned: 0, error: `Directory not found: ${dirPath}` };
  }

  collectFiles(absoluteDir);

  for (const filePath of scannedFiles) {
    const relPath = normalizePath(path.relative(rootDir, filePath));
    let content = '';
    let allLines = [];

    try {
      content = fs.readFileSync(filePath, 'utf8');
      allLines = content.split(/\r?\n/);
    } catch {
      continue;
    }

    // Check file size (complexity risk)
    if (allLines.length > MAX_FILE_LINES) {
      issues.push({
        file: relPath,
        type: 'large_file',
        severity: 'medium',
        line: allLines.length,
        description: `File exceeds ${MAX_FILE_LINES} lines (${allLines.length} lines) — complexity risk`,
      });
    }

    // Check route handler inline business logic
    const isRouteFile = /route\.(ts|tsx)$/.test(path.basename(filePath));
    if (isRouteFile) {
      // Count non-blank, non-import lines in the file as a rough handler size
      const handlerLines = allLines.filter((l) => {
        const trimmed = l.trim();
        return trimmed && !trimmed.startsWith('import ') && !trimmed.startsWith('//');
      });
      if (handlerLines.length > MAX_ROUTE_HANDLER_LINES) {
        issues.push({
          file: relPath,
          type: 'inline_business_logic',
          severity: 'medium',
          line: handlerLines.length,
          description: `Route file has ${handlerLines.length} non-import/comment lines — potential inline business logic`,
        });
      }
    }

    // Import analysis: read first LINES_TO_READ lines
    const headLines = allLines.slice(0, LINES_TO_READ);
    const importViolations = detectImportViolations(relPath, headLines);
    issues.push(...importViolations);
  }

  return {
    issues,
    files_scanned: scannedFiles.length,
  };
}

function buildOutput(mode, data) {
  return {
    agent: AGENT,
    label: LABEL,
    bot_id: BOT_ID,
    authority_level: AUTHORITY_LEVEL,
    mode,
    ...data,
  };
}

function buildStatusMode(rootDir, options = {}) {
  return buildOutput('status', {
    status: 'PASS',
    observe_only: true,
    reports_to: 'architecture-governor',
    may_mutate: false,
    may_stage: false,
    may_commit: false,
    summary: `${AGENT} (${LABEL}) — read-only architecture scanner. Reports to architecture-governor.`,
  });
}

function buildScanMode(rootDir, dirArg, options = {}) {
  const scanDir = dirArg || 'src/app/api';

  const scanResult = scanDirectory(scanDir, rootDir);

  if (scanResult.error) {
    return buildOutput('scan', {
      status: 'WARN',
      issues_found: false,
      issues: [],
      files_scanned: 0,
      directory: scanDir,
      error: scanResult.error,
      summary: `Scan could not complete: ${scanResult.error}`,
    });
  }

  const issuesByType = {};
  for (const issue of scanResult.issues) {
    issuesByType[issue.type] = (issuesByType[issue.type] || 0) + 1;
  }

  return buildOutput('scan', {
    status: scanResult.issues.length > 0 ? 'WARN' : 'PASS',
    issues_found: scanResult.issues.length > 0,
    issues: scanResult.issues,
    files_scanned: scanResult.files_scanned,
    directory: scanDir,
    summary: scanResult.issues.length === 0
      ? `No architecture issues found in ${scanResult.files_scanned} files.`
      : `Found ${scanResult.issues.length} issue(s) across ${scanResult.files_scanned} files: ${JSON.stringify(issuesByType)}`,
  });
}

function main(argv = process.argv.slice(2), options = {}) {
  const parsed = parseArgs(argv);
  const rootDir = options.rootDir || path.resolve(__dirname, '..');

  if (parsed.mode === 'scan') {
    return buildScanMode(rootDir, parsed.options.dir || null, options);
  }
  return buildStatusMode(rootDir, options);
}

module.exports = {
  AGENT,
  LABEL,
  BOT_ID,
  MAX_SCAN_FILES,
  buildOutput,
  buildStatusMode,
  buildScanMode,
  detectImportViolations,
  main,
  normalizePath,
  parseArgs,
  scanDirectory,
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
      error: error instanceof Error ? error.message : String(error),
    }, null, 2) + '\n');
    process.exit(1);
  }
}
