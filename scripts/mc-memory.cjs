#!/usr/bin/env node
/**
 * mc-memory.cjs — Mission Control memory CLI
 *
 * Commands:
 *   mc memory recall "<prompt>"
 *   mc memory audit "<prompt>"
 *   mc memory write "<content>"
 *   mc memory outcome <id> <outcome>
 *   mc memory status
 *   mc memory health
 */

'use strict';

const path = require('node:path');
const memoryApi = require('./memory-api.cjs');

// Parse arguments
const args = process.argv.slice(2);

function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent') {
      options.agent = args[++i] || 'cli';
    } else if (args[i] === '--task-id') {
      options.taskId = args[++i];
    } else if (args[i] === '--limit') {
      options.limit = args[++i] || 3;
    } else if (args[i] === '--run-id') {
      options.runId = args[++i];
    } else if (args[i] === '--explore') {
      options.explore = true;
    } else if (args[i] === '--raw-execution-log') {
      options.rawExecutionLog = true;
    }
  }
  return options;
}

function extractPrompt(args, command) {
  // Find the prompt: for recall/audit/write it's the first non-option argument after the command
  const idx = args.indexOf(command) + 1;
  if (args[idx] && !args[idx].startsWith('-')) {
    return args[idx];
  }
  return '';
}

function printUsage() {
  console.log(`
Mission Control Memory CLI

Usage: mc memory <command> [options]

Commands:
  recall "<prompt>"       Recall memories for a prompt
  audit "<prompt>"        Audit top-ranked memories with debug info
  write "<content>"       Write a new memory entry
  outcome <id> <outcome>  Mark outcome for a memory
  status                  Show memory status
  health                  Show health check

Options for recall/audit:
  --agent <name>          Agent name (default: 'cli')
  --task-id <id>          Task ID
  --limit <n>             Number of results (default: 3 for recall, 10 for audit)
  --run-id <id>           Run ID
  --explore               Explore mode: include underused patterns
  --raw-execution-log     Write raw execution log instead of pattern

Examples:
  mc memory recall "validate input" --agent hermes --limit 3
  mc memory audit "handle long operations" --agent hermes --limit 10
  mc memory write "Always validate inputs..." --source cli --category execution
  mc memory outcome 3 success --used-patterns 1,2,3 --primary-pattern-id 1
  mc memory status
  mc memory health
`);
}

function formatTable(data) {
  const lines = [];
  const headers = Object.keys(data[0] || {}).filter(k => k !== 'id'); // Skip id for header

  // Header row
  const headerStr = headers.map(h => h.padEnd(20)).join('  ');
  lines.push(headerStr);

  // Separator
  const sep = '─'.repeat(headerStr.length);
  lines.push(sep);

  // Data rows
  data.forEach(row => {
    const rowStr = headers.map(h => {
      const val = row[h];
      if (h === 'explanation') {
        // Truncate long explanations
        return String(val).substring(0, 20).padEnd(20);
      }
      if (h === 'content' || h === 'source_ref') {
        // Truncate content
        return String(val).substring(0, 20).padEnd(20);
      }
      if (h === 'tags') {
        return String(val).substring(0, 20).padEnd(20);
      }
      return String(val).padEnd(20);
    }).join('  ');
    lines.push(rowStr);
  });

  return lines.join('\n');
}

function recall(prompt, options) {
  const {
    agent = 'cli',
    taskId = null,
    limit = 3,
    runId = null,
    explore = false
  } = options;

  if (!prompt) {
    console.error('Error: prompt is required');
    printUsage();
    process.exit(1);
  }

  console.log(`\n=== MEMORY RECALL: "${prompt}" ===\n`);

  const result = memoryApi.recall(agent, {
    prompt,
    taskId,
    limit: parseInt(limit),
    runId,
    explore
  });

  if (result.selected.length === 0) {
    console.log('No memories found for this prompt.');
    console.log(`Used patterns: ${result.usedPatterns.join(', ') || 'none'}`);
    return result;
  }

  // Print table
  const tableData = result.selected.map((e, i) => ({
    'Rank': i + 1,
    'Score': e.score.toFixed(2),
    'Promotion': e.promotion_level,
    'Validation': e.validation_score.toFixed(2),
    'Causality': e.causality_score.toFixed(2),
    'Cluster': e.cluster_success_count + ' suc',
    'Preview': e.content.substring(0, 30) + '...',
    'Explanation': e.explanation
  }));

  console.log(formatTable(tableData));
  console.log(`\nUsed patterns: ${result.usedPatterns.join(', ') || 'none'}`);
  console.log(`Pruned: ${result.pruned_count} | Merged: ${result.merged_count}`);

  return result;
}

function audit(prompt, options) {
  const {
    agent = 'cli',
    taskId = null,
    limit = 10,
    runId = null
  } = options;

  if (!prompt) {
    console.error('Error: prompt is required');
    printUsage();
    process.exit(1);
  }

  console.log(`\n=== MEMORY AUDIT: "${prompt}" ===\n`);

  const result = memoryApi.audit(agent, {
    prompt,
    taskId,
    limit: parseInt(limit),
    runId
  });

  if (result.entries.length === 0) {
    console.log('No memories found.');
    return result;
  }

  // Print table
  const tableData = result.entries.map((e, i) => ({
    'Rank': i + 1,
    'Score': e.score.toFixed(3),
    'Promotion': e.promotion_level,
    'Validation': e.validation_score.toFixed(2),
    'Causality': e.causality_score.toFixed(2),
    'Cluster': `${e.cluster_success_count}s / ${e.cluster_failure_count}f`,
    'Preview': e.content.substring(0, 40) + '...',
    'Explanation': e.explanation.substring(0, 60) + '...'
  }));

  console.log(formatTable(tableData));

  // Summary
  console.log(`\nSummary:`);
  console.log(`  Total candidates: ${result.summary.total_candidates}`);
  console.log(`  Returned: ${result.summary.returned}`);
  console.log(`  Pruned: ${result.summary.pruned_count}`);
  console.log(`  Top score: ${result.summary.top_score.toFixed(2)}`);
  console.log(`  Warnings: ${result.summary.warning_count}`);

  if (result.summary.warnings.length > 0) {
    console.log(`\nWarnings:`);
    result.summary.warnings.forEach(w => {
      console.log(`  - Entry ${w.entryId}: ${w.reason}`);
    });
  }

  return result;
}

function write(content, options) {
  const {
    source = 'cli',
    category = 'execution',
    agent = null,
    taskId = null,
    runId = null,
    tags = null,
    confidence = null,
    sourceRef = null,
    project = null,
    rawExecutionLog = false
  } = options;

  if (!content) {
    console.error('Error: content is required');
    printUsage();
    process.exit(1);
  }

  console.log(`\n=== WRITING MEMORY ===`);
  console.log(`  Source: ${source}`);
  console.log(`  Category: ${category}`);
  console.log(`  Content: ${content.substring(0, 50)}...`);

  const id = memoryApi.write({
    source,
    category,
    content,
    agent,
    taskId,
    runId,
    tags,
    confidence,
    sourceRef,
    project,
    rawExecutionLog
  });

  console.log(`\nCreated entry with id: ${id.id}`);
  console.log(`  Source ref: ${id.source_ref || 'none'}`);

  return id;
}

function outcome(id, outcome, options) {
  const {
    usedPatterns = [],
    primaryPatternId = null,
    runId = null
  } = options;

  if (!outcome) {
    console.error('Error: outcome is required (success|failure|unknown)');
    printUsage();
    process.exit(1);
  }

  if (!id) {
    console.error('Error: memory id is required');
    printUsage();
    process.exit(1);
  }

  console.log(`\n=== MARKING OUTCOME ===`);
  console.log(`  Memory ID: ${id}`);
  console.log(`  Outcome: ${outcome}`);

  const result = memoryApi.markOutcome(id, outcome, {
    usedPatterns,
    primaryPatternId,
    runId
  });

  if (result.updated) {
    console.log(`  Updated: ${result.updated}`);
    console.log(`  New tags: ${result.tags || ''}`);
    console.log(`  Outcome tag: ${result.outcome_tag || outcome}`);
  } else {
    console.log(`  Reason: ${result.reason || 'unknown'}`);
  }

  return result;
}

function status() {
  console.log(`\n=== MEMORY STATUS ===\n`);

  const result = memoryApi.status();

  console.log(`Total memories: ${result.total_memories}`);
  console.log(`By source:`);
  (result.by_source || []).forEach(row => {
    console.log(`  ${row.source}: ${row.count}`);
  });
  console.log(`By category:`);
  (result.by_category || []).forEach(row => {
    console.log(`  ${row.category}: ${row.count}`);
  });
  console.log(`Outcome counts: ${JSON.stringify(result.outcome_counts)}`);
  console.log(`Promoted counts: ${JSON.stringify(result.promoted_counts)}`);
  console.log(`Recent count: ${result.recent_count}`);

  if (result.warnings.length > 0) {
    console.log(`Warnings:`);
    result.warnings.forEach(w => {
      console.log(`  - ${w}`);
    });
  }

  return result;
}

function health() {
  console.log(`\n=== HEALTH CHECK ===\n`);

  const result = memoryApi.health();

  if (result.ok) {
    console.log(`OK - All checks passed`);
    console.log(`  Checks:`);
    console.log(`    - memory_db_accessible: ${result.checks.memory_db_accessible}`);
    console.log(`    - required_exports_present: ${result.checks.required_exports_present}`);
    console.log(`    - deterministic_scoring: ${result.checks.deterministic_scoring}`);
    console.log(`    - no_nan_score: ${result.checks.no_nan_score}`);
  } else {
    console.log(`ISSUES DETECTED:`);
    result.issues.forEach(issue => {
      console.log(`  - ${issue}`);
    });
  }

  return result;
}

// Parse command
const command = args[0];

if (!command) {
  printUsage();
  process.exit(0);
}

// Parse options
const options = parseOptions(args);

// Extract prompt
const prompt = extractPrompt(args, command);

// Handle commands
switch (command) {
  case 'recall':
    recall(prompt, options);
    break;
  case 'audit':
    audit(prompt, options);
    break;
  case 'write':
    write(prompt, options);
    break;
  case 'outcome':
    if (args.length < 3) {
      console.error('Error: outcome requires <id> and <outcome>');
      printUsage();
      process.exit(1);
    }
    const id = args[1];
    const outcome = args[2];
    const usedPatternsArg = args.find(a => a.startsWith('--used-patterns'))?.replace('--used-patterns=', '');
    const usedPatterns = usedPatternsArg?.split(',').map(s => s.trim());
    outcome(id, outcome, {
      ...options,
      usedPatterns,
      'primary-pattern-id': args.find(a => a.startsWith('--primary-pattern-id'))?.replace('--primary-pattern-id=', ''),
      runId: options['run-id']
    });
    break;
  case 'status':
    status();
    break;
  case 'health':
    health();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
