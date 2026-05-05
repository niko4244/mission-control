#!/usr/bin/env node
/**
 * PR Reviewer Bot v1
 * Observe-only PR review, risk classification, and reviewer comment generation.
 *
 * Reads PR metadata via gh CLI or GitHub public API.
 * Classifies changed files by risk, scans diff for red flags,
 * runs local validation suite, emits structured JSON + Markdown comment.
 * Never merges, commits, pushes, or modifies any file.
 *
 * Usage:
 *   node scripts/pr-reviewer.cjs --repo owner/repo --pr 123
 *   node scripts/pr-reviewer.cjs --repo owner/repo --pr 123 --post-comment
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const LABEL = 'OBSERVE ONLY';
const IS_WIN = process.platform === 'win32';
const PNPM = IS_WIN ? 'pnpm.cmd' : 'pnpm';

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    repo: null,
    pr: null,
    postComment: false,
    skipValidation: false,
    merge: false,
    autoMerge: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') args.repo = argv[++i] ?? null;
    else if (a === '--pr') args.pr = Number(argv[++i]) || null;
    else if (a === '--post-comment') args.postComment = true;
    else if (a === '--skip-validation') args.skipValidation = true;
    else if (a === '--merge') args.merge = true;
    else if (a === '--auto-merge') args.autoMerge = true;
  }
  return args;
}

// ── Merge refusal ─────────────────────────────────────────────────────────────

function checkMergeRefusal(args) {
  if (args.merge || args.autoMerge) {
    const flag = args.merge ? '--merge' : '--auto-merge';
    return { refused: true, flag };
  }
  return { refused: false, flag: null };
}

// ── gh CLI availability ───────────────────────────────────────────────────────

function isGhAvailable() {
  const r = spawnSync('gh', ['--version'], { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 });
  return r.status === 0;
}

function isGhAuthenticated() {
  const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf-8', stdio: 'pipe', timeout: 5000 });
  return r.status === 0;
}

// ── gh CLI PR fetch ───────────────────────────────────────────────────────────

function fetchPrMetaViaGh(repo, prNumber) {
  const r = spawnSync('gh', [
    'pr', 'view', String(prNumber), '--repo', repo,
    '--json', 'title,body,state,baseRefName,headRefName,additions,deletions,changedFiles,mergeable,author,number,url',
  ], { encoding: 'utf-8', stdio: 'pipe', timeout: 20000 });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

function fetchPrFilesViaGh(repo, prNumber) {
  const r = spawnSync('gh', [
    'pr', 'view', String(prNumber), '--repo', repo, '--json', 'files',
  ], { encoding: 'utf-8', stdio: 'pipe', timeout: 20000 });
  if (r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    return Array.isArray(parsed.files) ? parsed.files : null;
  } catch { return null; }
}

function fetchPrDiffViaGh(repo, prNumber) {
  const r = spawnSync('gh', [
    'pr', 'diff', String(prNumber), '--repo', repo,
  ], { encoding: 'utf-8', stdio: 'pipe', timeout: 20000 });
  if (r.status !== 0) return null;
  return r.stdout || null;
}

function resolveFetchedHeadSha() {
  const r = spawnSync('git', ['rev-parse', 'FETCH_HEAD'], {
    encoding: 'utf-8', stdio: 'pipe', timeout: 30000, cwd: ROOT,
  });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.trim();
}

function fetchPrDiffViaGit(baseRef, headRef) {
  if (!baseRef || !headRef) return null;
  const fetchBase = spawnSync('git', ['fetch', 'origin', baseRef], {
    encoding: 'utf-8', stdio: 'pipe', timeout: 30000, cwd: ROOT,
  });
  if (fetchBase.status !== 0) return null;
  const baseSha = resolveFetchedHeadSha();
  if (!baseSha) return null;

  const fetchHead = spawnSync('git', ['fetch', 'origin', headRef], {
    encoding: 'utf-8', stdio: 'pipe', timeout: 30000, cwd: ROOT,
  });
  if (fetchHead.status !== 0) return null;
  const headSha = resolveFetchedHeadSha();
  if (!headSha) return null;

  const r = spawnSync('git', ['diff', `${baseSha}...${headSha}`], {
    encoding: 'utf-8', stdio: 'pipe', timeout: 30000, cwd: ROOT,
  });
  if (r.status === 0 && r.stdout) return r.stdout;

  const fallback = spawnSync('git', ['diff', baseSha, headSha], {
    encoding: 'utf-8', stdio: 'pipe', timeout: 30000, cwd: ROOT,
  });
  if (fallback.status !== 0 || !fallback.stdout) return null;
  return fallback.stdout;
}

// ── GitHub REST API fallback ──────────────────────────────────────────────────

function fetchViaApi(urlPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: urlPath,
      method: 'GET',
      headers: {
        'User-Agent': 'mission-control-pr-reviewer-bot/1',
        'Accept': 'application/vnd.github+json',
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('API timeout')); });
    req.end();
  });
}

async function fetchPrMetaViaApi(repo, prNumber) {
  try {
    const { status, body } = await fetchViaApi(`/repos/${repo}/pulls/${prNumber}`);
    if (status !== 200 || typeof body !== 'object') return null;
    return {
      number: body.number,
      title: body.title,
      body: body.body,
      state: body.state,
      baseRefName: body.base?.ref,
      headRefName: body.head?.ref,
      additions: body.additions,
      deletions: body.deletions,
      changedFiles: body.changed_files,
      mergeable: body.mergeable,
      author: body.user?.login,
      url: body.html_url,
    };
  } catch { return null; }
}

async function fetchPrFilesViaApi(repo, prNumber) {
  try {
    const { status, body } = await fetchViaApi(`/repos/${repo}/pulls/${prNumber}/files?per_page=100`);
    if (status !== 200 || !Array.isArray(body)) return null;
    return body.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, status: f.status }));
  } catch { return null; }
}

// ── File classification ───────────────────────────────────────────────────────

const RISK_RULES = [
  { pattern: /^scripts\//, category: 'scripts', risk: 'high' },
  { pattern: /^src\/app\/api\//, category: 'api-routes', risk: 'high' },
  { pattern: /package\.json$|pnpm-lock\.yaml$|\.npmrc$/, category: 'dependencies', risk: 'high' },
  { pattern: /(^|\/)\.(env)(\.|$)/, category: 'config', risk: 'high' },
  { pattern: /data\/mission-control\/agent-registry\.json/, category: 'registry', risk: 'high' },
  // Test files before auth/lib patterns so auth.test.ts isn't misclassified as auth
  { pattern: /\.(test|spec)\.[jt]sx?$/, category: 'tests', risk: 'low' },
  { pattern: /\/middleware\.ts$|\/middleware\/|\/auth\.ts$|\/auth\/|\/security\.ts$|\/security\//, category: 'auth', risk: 'high' },
  { pattern: /src\/lib\//, category: 'lib', risk: 'medium' },
  { pattern: /src\/components\//, category: 'components', risk: 'low' },
  { pattern: /^docs\/|\.md$/, category: 'docs', risk: 'low' },
  { pattern: /\.(yml|yaml)$/, category: 'config', risk: 'medium' },
  { pattern: /Dockerfile|docker-compose/, category: 'infra', risk: 'medium' },
];

function classifyFile(filePath) {
  for (const rule of RISK_RULES) {
    if (rule.pattern.test(filePath)) {
      return { category: rule.category, risk: rule.risk };
    }
  }
  return { category: 'other', risk: 'low' };
}

const STRICT_ZONE_PATTERNS = [
  /^scripts\//,
  /^src\/app\/api\//,
  /execution|gate|approval/i,
];

function isStrictZone(filePath) {
  return STRICT_ZONE_PATTERNS.some((p) => p.test(filePath));
}

// ── Red flag detection ────────────────────────────────────────────────────────

const RED_FLAG_PATTERNS = [
  {
    name: 'filesystem-mutation',
    pattern: /fs\.(unlink|rm|write|append|truncate)(Sync)?\s*\(/,
    severity: 'high',
  },
  {
    name: 'shell-execution',
    pattern: /\bexecSync\s*\(|\bspawnSync\s*\(|\bexec\s*\(|\bspawn\s*\(|require\s*\(\s*['"]child_process['"]/,
    severity: 'high',
  },
  {
    name: 'dynamic-execution',
    pattern: /\beval\s*\(|new\s+Function\s*\(/,
    severity: 'critical',
  },
  {
    name: 'network-call',
    pattern: /\bfetch\s*\(|axios\.|https?\.(get|post|request)\s*\(|new\s+XMLHttpRequest/,
    severity: 'medium',
  },
  {
    name: 'auth-bypass',
    pattern: /skipAuth|bypass[_\s-]?auth|isAuthenticated\s*[=!]=\s*false/i,
    severity: 'critical',
  },
  {
    name: 'approval-bypass',
    pattern: /skipApproval|auto[_\s-]?approve|approval[_\s-]?bypass|skip[_\s-]?gate/i,
    severity: 'critical',
  },
  {
    name: 'default-allow',
    pattern: /default[_\s-]?allow\b|allowAll\b/i,
    severity: 'high',
  },
  {
    name: 'secrets-in-code',
    pattern: /(?:KEY|SECRET|TOKEN|PASSWORD|PASS|API_KEY)\s*=\s*['"`][^'"`\s]{6,}/,
    severity: 'critical',
  },
  {
    name: 'tests-removed',
    pattern: /^-\s*(it|describe|test)\s*\(/,
    severity: 'medium',
  },
  {
    name: 'new-dependency',
    pattern: /^\+\s*"(?!@types\/)[a-z@][a-z0-9/@._-]+"\s*:/,
    severity: 'medium',
  },
];

function scanRedFlags(diff) {
  if (!diff) {
    return [{
      flag: 'diff-unavailable',
      severity: 'critical',
      count: 1,
      examples: [],
      message: 'PR diff could not be inspected; red-flag scan is incomplete.',
    }];
  }
  const findings = [];
  const lines = diff.split('\n');

  for (const { name, pattern, severity } of RED_FLAG_PATTERNS) {
    const examples = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isAddedLine = line.startsWith('+') && !line.startsWith('+++');
      const isRemovedLine = line.startsWith('-') && !line.startsWith('---');
      const shouldScan = name === 'tests-removed' ? isRemovedLine : isAddedLine;
      if (shouldScan && pattern.test(line)) {
        examples.push({ line: i + 1, text: line.slice(0, 120) });
        if (examples.length >= 3) break;
      }
    }
    if (examples.length > 0) {
      findings.push({ flag: name, severity, count: examples.length, examples });
    }
  }

  return findings;
}

// ── Local validation ──────────────────────────────────────────────────────────

function runValidation(skipValidation = false) {
  if (skipValidation) {
    return {
      passed: true,
      skipped: true,
      steps: [
        { step: 'typecheck', passed: true, skipped: true, duration_ms: 0 },
        { step: 'test', passed: true, skipped: true, duration_ms: 0 },
        { step: 'build', passed: true, skipped: true, duration_ms: 0 },
        { step: 'systems-curator', passed: true, skipped: true, duration_ms: 0 },
        { step: 'mc-coordinator', passed: true, skipped: true, duration_ms: 0 },
      ],
    };
  }

  const steps = [];

  function runStep(label, cmd, args, opts = {}) {
    const start = Date.now();
    const r = spawnSync(cmd, args, {
      cwd: ROOT,
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: opts.timeout || 120000,
      env: { ...process.env, ...(opts.env || {}) },
      // .cmd files on Windows require shell:true
      ...(IS_WIN && cmd === PNPM ? { shell: true } : {}),
    });
    const duration_ms = Date.now() - start;
    const passed = r.status === 0 && !r.error;
    steps.push({
      step: label,
      passed,
      exit_code: r.status,
      duration_ms,
      ...(r.error ? { error: r.error.message } : {}),
      ...(r.stderr && !passed ? { stderr_excerpt: r.stderr.slice(0, 400) } : {}),
    });
    return passed;
  }

  runStep('typecheck', PNPM, ['run', 'typecheck'], { timeout: 90000 });
  runStep('test', PNPM, ['test', '--run'], {
    timeout: 360000,
    env: { NODE_OPTIONS: '--max-old-space-size=4096' },
  });
  runStep('build', PNPM, ['run', 'build'], { timeout: 360000 });
  runStep('systems-curator', 'node', ['scripts/systems-curator.cjs'], { timeout: 30000 });
  runStep('mc-coordinator', 'node', ['scripts/mc-coordinator.cjs'], { timeout: 90000 });

  return { passed: steps.every((s) => s.passed), skipped: false, steps };
}

// ── Verdict ───────────────────────────────────────────────────────────────────

function buildVerdict(files, redFlags, validation) {
  const criticalFlags = redFlags.filter((f) => f.severity === 'critical');
  const highFlags = redFlags.filter((f) => f.severity === 'high');
  const highRiskFiles = files.filter((f) => f.risk === 'high');
  const failedSteps = (validation.steps || []).filter((s) => !s.passed && !s.skipped);

  let risk_level = 0;
  const reasons = [];

  if (criticalFlags.length > 0) {
    risk_level = 3;
    reasons.push(`${criticalFlags.length} critical red flag(s): ${criticalFlags.map((f) => f.flag).join(', ')}`);
  }
  if (highFlags.length > 0) {
    risk_level = Math.max(risk_level, 2);
    reasons.push(`${highFlags.length} high-severity red flag(s): ${highFlags.map((f) => f.flag).join(', ')}`);
  }
  if (highRiskFiles.length > 0) {
    risk_level = Math.max(risk_level, 2);
    reasons.push(`${highRiskFiles.length} high-risk file(s) modified`);
  }
  if (failedSteps.length > 0) {
    risk_level = Math.max(risk_level, 2);
    reasons.push(`Validation failed: ${failedSteps.map((s) => s.step).join(', ')}`);
  }
  if (risk_level === 0 && redFlags.length > 0) {
    risk_level = 1;
    reasons.push(`${redFlags.length} informational flag(s): ${redFlags.map((f) => f.flag).join(', ')}`);
  }

  const status = risk_level >= 2 ? 'FAIL' : risk_level === 1 ? 'WARN' : 'OK';
  const recommendation =
    risk_level >= 3 ? 'BLOCK — critical issues require human review before merge' :
    risk_level === 2 ? 'REVIEW — non-trivial risk, human review required' :
    risk_level === 1 ? 'REVIEW — minor flags, consider reviewing before merge' :
    'LGTM — no issues detected';

  return { status, risk_level, recommendation, reasons };
}

// ── Markdown comment ──────────────────────────────────────────────────────────

function buildMarkdownComment(report) {
  const { pr_meta, file_summary, red_flags, validation, verdict, pr } = report;
  const rl = verdict.risk_level;
  const icon = rl >= 3 ? '🔴' : rl >= 1 ? '🟡' : '🟢';
  const lines = [];

  lines.push(`## ${icon} PR Review — Mission Control Bot (Observe-Only)`);
  lines.push('');

  if (pr_meta) {
    lines.push(`**PR**: #${pr_meta.number} — ${pr_meta.title}`);
    const author = typeof pr_meta.author === 'object' ? pr_meta.author?.login : pr_meta.author;
    lines.push(`**State**: \`${pr_meta.state}\` | **Author**: ${author ?? 'unknown'}`);
    const fileCount = pr_meta.changedFiles ?? file_summary?.total ?? '?';
    lines.push(`**Changes**: +${pr_meta.additions} / -${pr_meta.deletions} across ${fileCount} file(s)`);
  } else {
    lines.push(`**PR**: ${pr?.repo ?? '?'}#${pr?.number ?? '?'} (metadata unavailable)`);
  }
  lines.push('');

  const diffUnavailable = (red_flags || []).some((f) => f.flag === 'diff-unavailable');
  if (diffUnavailable) {
    lines.push('> ⚠️ **INCOMPLETE REVIEW** — PR diff could not be inspected. Red-flag scan is incomplete. Do not treat this as a clean review.');
    lines.push('');
  }

  lines.push(`### Verdict: ${verdict.recommendation}`);
  lines.push(`**Risk level**: ${verdict.risk_level}/3 | **Status**: \`${verdict.status}\``);
  if (verdict.reasons.length > 0) {
    lines.push('');
    for (const r of verdict.reasons) lines.push(`- ${r}`);
  }
  lines.push('');

  if (file_summary && file_summary.files && file_summary.files.length > 0) {
    lines.push('### Changed Files by Risk');
    const byRisk = { high: [], medium: [], low: [] };
    for (const f of file_summary.files) {
      const bucket = f.risk === 'high' ? 'high' : f.risk === 'medium' ? 'medium' : 'low';
      byRisk[bucket].push(f.path);
    }
    if (byRisk.high.length > 0) {
      lines.push(`**High** (${byRisk.high.length}):`);
      for (const f of byRisk.high) lines.push(`- \`${f}\``);
    }
    if (byRisk.medium.length > 0) {
      lines.push(`**Medium** (${byRisk.medium.length}):`);
      for (const f of byRisk.medium) lines.push(`- \`${f}\``);
    }
    if (byRisk.low.length > 0) {
      lines.push(`**Low**: ${byRisk.low.length} file(s)`);
    }
    lines.push('');
  }

  if (red_flags && red_flags.length > 0) {
    lines.push('### Red Flags');
    for (const flag of red_flags) {
      const note = flag.message ? ` — ${flag.message}` : '';
      lines.push(`- **${flag.flag}** (${flag.severity}): ${flag.count} occurrence(s)${note}`);
      if (flag.examples && flag.examples.length > 0) {
        lines.push('  ```');
        for (const ex of flag.examples) lines.push(`  ${ex.text}`);
        lines.push('  ```');
      }
    }
    lines.push('');
  }

  if (validation) {
    lines.push('### Validation');
    if (validation.skipped) {
      lines.push('- ⏭ validation skipped');
    } else {
      for (const step of (validation.steps || [])) {
        const stepIcon = step.passed ? '✅' : '❌';
        lines.push(`- ${stepIcon} \`${step.step}\` (${step.duration_ms}ms)`);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('*PR Reviewer Bot v1 — OBSERVE ONLY — no merge capability*');

  return lines.join('\n');
}

// ── Post comment ──────────────────────────────────────────────────────────────

function postCommentViaGh(repo, prNumber, comment) {
  const r = spawnSync('gh', [
    'pr', 'comment', String(prNumber), '--repo', repo, '--body', comment,
  ], { encoding: 'utf-8', stdio: 'pipe', timeout: 15000 });
  return { posted: r.status === 0, error: r.stderr || r.error?.message || null };
}

function resolveCommentPost(repo, prNumber, comment, ghAuthenticated) {
  if (ghAuthenticated) {
    return postCommentViaGh(repo, prNumber, comment);
  }
  return {
    posted: false,
    reason: 'gh not authenticated — comment printed to stdout instead',
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run(rawArgs) {
  const args = parseArgs(rawArgs);
  const timestamp = new Date().toISOString();

  const mergeCheck = checkMergeRefusal(args);
  if (mergeCheck.refused) {
    return {
      agent: 'PR Reviewer Bot v1',
      label: LABEL,
      status: 'FAIL',
      risk_level: 3,
      timestamp,
      error: `REFUSED: ${mergeCheck.flag} is not supported. This agent is observe-only and will never merge.`,
      warnings: [`${mergeCheck.flag} was passed — PR Reviewer Bot has no merge capability`],
      recommended_next_actions: ['Remove the merge flag. Re-run without it for a review-only report.'],
      safety: { observe_only: true, merge_capable: false },
    };
  }

  if (!args.repo || !args.pr) {
    return {
      agent: 'PR Reviewer Bot v1',
      label: LABEL,
      status: 'FAIL',
      risk_level: 1,
      timestamp,
      error: 'Missing required arguments: --repo <owner/repo> --pr <number>',
      warnings: ['No PR target specified'],
      recommended_next_actions: ['Run: node scripts/pr-reviewer.cjs --repo owner/repo --pr 123'],
      safety: { observe_only: true, merge_capable: false },
    };
  }

  const ghAvailable = isGhAvailable();
  const ghAuthenticated = ghAvailable && isGhAuthenticated();

  let prMeta = null;
  let prFiles = null;
  let prDiff = null;
  let metaSource = 'none';
  let diffSource = 'none';

  if (ghAvailable) {
    prMeta = fetchPrMetaViaGh(args.repo, args.pr);
    if (prMeta) {
      prFiles = fetchPrFilesViaGh(args.repo, args.pr);
      metaSource = 'gh-cli';
    }
  }

  if (!prMeta) {
    prMeta = await fetchPrMetaViaApi(args.repo, args.pr);
    if (prMeta) {
      prFiles = await fetchPrFilesViaApi(args.repo, args.pr);
      metaSource = 'github-api';
    }
  }

  if (prMeta) {
    const localDiff = fetchPrDiffViaGit(prMeta.baseRefName, prMeta.headRefName);
    if (localDiff) {
      prDiff = localDiff;
      diffSource = 'local-git';
    }
    if (!prDiff && ghAvailable) {
      prDiff = fetchPrDiffViaGh(args.repo, args.pr);
      if (prDiff) diffSource = 'gh-cli';
    }
  }

  const files = (prFiles || []).map((f) => {
    const classified = classifyFile(f.path);
    return { path: f.path, ...classified, strict_zone: isStrictZone(f.path) };
  });

  const fileSummary = {
    total: files.length,
    files,
    high_risk_count: files.filter((f) => f.risk === 'high').length,
    medium_risk_count: files.filter((f) => f.risk === 'medium').length,
    low_risk_count: files.filter((f) => f.risk === 'low').length,
    strict_zone_count: files.filter((f) => f.strict_zone).length,
  };

  const redFlags = scanRedFlags(prDiff);
  const validation = runValidation(args.skipValidation);
  const verdict = buildVerdict(files, redFlags, validation);

  const report = {
    agent: 'PR Reviewer Bot v1',
    label: LABEL,
    status: verdict.status,
    risk_level: verdict.risk_level,
    timestamp,
    pr: { repo: args.repo, number: args.pr },
    meta_source: metaSource,
    diff_source: diffSource,
    pr_meta: prMeta,
    file_summary: fileSummary,
    red_flags: redFlags,
    validation,
    verdict,
    warnings: verdict.reasons,
    recommended_next_actions: [verdict.recommendation],
    safety: { observe_only: true, merge_capable: false, commit_capable: false, push_capable: false },
  };

  const markdownComment = buildMarkdownComment(report);
  report.markdown_comment = markdownComment;

  if (args.postComment) {
    const posted = resolveCommentPost(args.repo, args.pr, markdownComment, ghAuthenticated);
    report.comment_posted = posted;
    if (!posted.posted) {
      // Fallback: the markdown comment is already in report.markdown_comment
      report.comment_posted.fallback = 'markdown_comment field contains the comment text';
    }
  }

  return report;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  parseArgs,
  checkMergeRefusal,
  classifyFile,
  isStrictZone,
  scanRedFlags,
  buildVerdict,
  buildMarkdownComment,
  resolveCommentPost,
  isGhAvailable,
  isGhAuthenticated,
  fetchPrDiffViaGit,
};

if (require.main === module) {
  run(process.argv.slice(2))
    .then((report) => {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      process.exit(report.status === 'FAIL' ? 1 : 0);
    })
    .catch((err) => {
      process.stdout.write(JSON.stringify({
        agent: 'PR Reviewer Bot v1',
        label: LABEL,
        status: 'FAIL',
        risk_level: 3,
        timestamp: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
        warnings: ['Unexpected error in PR Reviewer Bot'],
        recommended_next_actions: ['Check scripts/pr-reviewer.cjs for bugs'],
        safety: { observe_only: true, merge_capable: false },
      }, null, 2) + '\n');
      process.exit(1);
    });
}
