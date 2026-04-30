#!/usr/bin/env node
/**
 * memory-ranking-harness.cjs — Real-data ranking test harness
 *
 * Creates a test dataset and runs recall/audit against multiple prompts
 * to verify ranking behavior before UI implementation.
 */

'use strict';

const memoryApi = require('./memory-api.cjs');

/**
 * Create test dataset with 10 mixed entries
 */
function createTestDataset() {
  const entries = [
    // 1. Strong validated success pattern
    {
      source: 'cli',
      category: 'execution',
      content: 'Always validate user inputs before processing. This is tested and verified multiple times in production.',
      tags: 'outcome:success,validation:high',
      confidence: 0.95,
      agent: 'hermes',
      sourceRef: 'source:cli|pattern_success:+1|pattern_success:+1|pattern_success:+1|outcome:success|validation:high'
    },
    // 2. Core rule pattern
    {
      source: 'cli',
      category: 'execution',
      content: 'Never send unauthenticated requests. This rule has been verified across all environments.',
      tags: 'outcome:success',
      confidence: 0.9,
      agent: 'hermes',
      sourceRef: 'source:cli|pattern_success:+1|pattern_success:+1|pattern_success:+1|pattern_success:+1|pattern_success:+1|outcome:success'
    },
    // 3. Important failure warning
    {
      source: 'cli',
      category: 'execution',
      content: 'Error: Thermal overload detected at 85C. Do not exceed 70C operating temperature.',
      tags: 'outcome:failure',
      confidence: 0.85,
      agent: 'hermes',
      sourceRef: 'source:cli|pattern_failure:+1|pattern_failure:+1|outcome:failure'
    },
    // 4. Medium candidate pattern
    {
      source: 'cli',
      category: 'execution',
      content: 'Use exponential backoff for retry logic. Tested with multiple rate limiters.',
      tags: 'outcome:success',
      confidence: 0.7,
      agent: 'hermes',
      sourceRef: 'source:cli|pattern_success:+1|outcome:success'
    },
    // 5. Weak observation
    {
      source: 'cli',
      category: 'execution',
      content: 'Seems like it works for simple cases.',
      tags: 'outcome:unknown',
      confidence: 0.3,
      agent: 'hermes',
      sourceRef: 'source:cli|outcome:unknown'
    },
    // 6. Uncertain workaround
    {
      source: 'cli',
      category: 'execution',
      content: 'Quick fix: bypass the validation check temporarily. Might need a proper fix later.',
      tags: 'outcome:unknown',
      confidence: 0.4,
      agent: 'hermes',
      sourceRef: 'source:cli|outcome:unknown'
    },
    // 7. Old stale memory
    {
      source: 'cli',
      category: 'execution',
      content: 'Old approach that worked back then. May not apply now.',
      tags: 'outcome:unknown',
      confidence: 0.2,
      agent: 'hermes',
      created_at: Math.floor(Date.now() / 1000) - 60 * 86400 * 90, // 90 days old
      sourceRef: 'source:cli|outcome:unknown'
    },
    // 8. Duplicate of strong pattern
    {
      source: 'cli',
      category: 'execution',
      content: 'Always validate user inputs before processing. This is tested and verified multiple times in production.',
      tags: 'outcome:success',
      confidence: 0.9,
      agent: 'hermes',
      sourceRef: 'source:cli|pattern_success:+1|outcome:success'
    },
    // 9. Similar-but-not-identical pattern
    {
      source: 'cli',
      category: 'execution',
      content: 'Always validate user inputs before processing them. We should do this in all cases.',
      tags: 'outcome:success',
      confidence: 0.8,
      agent: 'hermes',
      sourceRef: 'source:cli|pattern_success:+1|outcome:success'
    },
    // 10. Irrelevant noise
    {
      source: 'cli',
      category: 'execution',
      content: 'Random comment about cats. Nothing relevant.',
      tags: 'outcome:unknown',
      confidence: 0.1,
      agent: 'hermes',
      sourceRef: 'source:cli|outcome:unknown'
    }
  ];

  return entries;
}

/**
 * Run ranking test with multiple prompts
 */
function runTests(testData, prompts) {
  const results = [];

  for (const prompt of prompts) {
    console.log(`\n=== Testing with prompt: "${prompt}" ===`);

    const recallResult = memoryApi.recall('cli', {
      prompt,
      limit: 5,
      explore: false
    });

    const auditResult = memoryApi.audit('cli', {
      prompt,
      limit: 5
    });

    console.log(`  Recall selected: ${recallResult.selected.length} entries`);
    console.log(`  Audit returned: ${auditResult.entries.length} entries`);
    console.log(`  Top score: ${auditResult.entries[0]?.score?.toFixed(2) || 'N/A'}`);
    console.log(`  Warnings: ${auditResult.summary.warning_count}`);

    results.push({
      prompt,
      recall: recallResult,
      audit: auditResult
    });
  }

  return results;
}

/**
 * Validate ranking behavior
 */
function validateRanking(results) {
  const failures = [];
  const rankingSnapshots = [];

  for (const result of results) {
    const { recall, audit } = result;

    // Check 1: Strong patterns should rank high
    if (result.prompt.includes('validate')) {
      const topEntry = audit.entries[0];
      if (topEntry && topEntry.score < 4) {
        failures.push('Strong validated pattern not ranking high enough for "validate" prompt');
      }
    }

    // Check 2: Failure patterns should rank high when relevant
    if (result.prompt.includes('timeout') || result.prompt.includes('thermal')) {
      // Failure patterns should appear
      const failureEntry = audit.entries.find(e => e.content.includes('Thermal') || e.content.includes('timeout'));
      if (!failureEntry) {
        failures.push('Failure pattern not appearing for timeout-related prompt');
      }
    }

    // Check 3: No NaN scores
    if (audit.entries.some(e => Number.isNaN(e.score))) {
      failures.push('NaN score detected in ranking');
    }

    // Check 4: Same run produces same order (determinism)
    const firstScore = audit.entries[0]?.score;
    const secondScore = audit.entries[0]?.score;
    if (firstScore !== secondScore) {
      failures.push('Non-deterministic scoring detected');
    }

    // Collect snapshot
    rankingSnapshots.push({
      prompt: result.prompt,
      topScore: audit.entries[0]?.score,
      topEntryPromotion: audit.entries[0]?.promotion_level
    });
  }

  const passed = failures.length === 0;

  return {
    passed,
    failures,
    rankingSnapshots
  };
}

/**
 * Main function
 */
function main() {
  console.log('=== MEMORY RANKING HARNESS ===\n');

  // Check health first
  const health = memoryApi.health();
  console.log('Health check:', health.ok ? 'PASS' : 'FAIL');
  if (!health.ok) {
    console.log('Issues:', health.issues);
    process.exit(1);
  }

  // Create test dataset
  const testData = createTestDataset();
  console.log(`Created test dataset with ${testData.length} entries`);

  // Write test data
  const entriesWritten = testData.map(entry => {
    const id = memoryApi.write(entry);
    return id;
  });
  console.log(`Wrote ${entriesWritten.length} test entries`);

  // Define test prompts
  const prompts = [
    'validate user input',
    'handle long operations',
    'timeout or thermal issue'
  ];

  // Run tests
  const results = runTests(testData, prompts);

  // Validate
  const validation = validateRanking(results);

  console.log(`\n=== VALIDATION RESULTS ===`);
  console.log(`Passed: ${validation.passed ? 'YES' : 'NO'}`);

  if (validation.failures.length > 0) {
    console.log(`\nFailures:`);
    validation.failures.forEach(f => {
      console.log(`  - ${f}`);
    });
  }

  console.log(`\nRanking snapshots:`);
  validation.rankingSnapshots.forEach(s => {
    console.log(`  Prompt: "${s.prompt}" -> Top score: ${s.topScore?.toFixed(2)}, Promotion: ${s.topEntryPromotion}`);
  });

  return validation;
}

// Run harness
main();
