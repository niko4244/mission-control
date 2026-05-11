#!/usr/bin/env node
/**
 * agent-daemon.cjs
 * Persistent local agent daemon for Mission Control.
 *
 * Keeps agents alive (heartbeat), routes work, runs analysis loops,
 * and posts results back to Mission Control as activities/tasks.
 *
 * Agents managed:
 *   SportsClaw   — sports picks, odds research, result tracking
 *   TradingDesk  — pre-market analysis, position tracking
 *   SysBot       — governance scan, system health
 *   Coder        — test validation, code health
 *   SecurityBot  — security governance checks
 *   Researcher   — market/news research for portfolio agents
 *
 * Usage:
 *   node scripts/agent-daemon.cjs            # run all agents
 *   node scripts/agent-daemon.cjs --agents SportsClaw,TradingDesk
 *   node scripts/agent-daemon.cjs --once     # single pass, no loop
 *
 * Environment:
 *   MC_URL      — Mission Control base URL (default: http://127.0.0.1:3000)
 *   API_KEY     — Mission Control API key
 *   OLLAMA_URL  — Ollama API base URL (default: http://localhost:11434)
 */

'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const MC_URL    = process.env.MC_URL    || 'http://127.0.0.1:3000';
const API_KEY   = process.env.API_KEY   || process.env.MC_API_KEY || '';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const ROOT      = path.resolve(__dirname, '..');

// ── Agent registry ─────────────────────────────────────────────────────────
const AGENTS = {
  SportsClaw:  { id: 4,  emoji: '🏆', type: 'portfolio', heartbeat_interval_ms: 4 * 60_000 },
  TradingDesk: { id: 15, emoji: '📈', type: 'portfolio', heartbeat_interval_ms: 4 * 60_000 },
  SysBot:      { id: 14, emoji: '🤖', type: 'governance', heartbeat_interval_ms: 8 * 60_000 },
  Coder:       { id: 2,  emoji: '💻', type: 'governance', heartbeat_interval_ms: 8 * 60_000 },
  SecurityBot: { id: 13, emoji: '🔒', type: 'governance', heartbeat_interval_ms: 8 * 60_000 },
  Researcher:  { id: 3,  emoji: '🔬', type: 'research',   heartbeat_interval_ms: 8 * 60_000 },
};

const log = (agent, msg) => {
  const ts = new Date().toLocaleTimeString();
  process.stdout.write(`[${ts}] ${AGENTS[agent]?.emoji || '🤖'} ${agent}: ${msg}\n`);
};

const err = (agent, msg) => {
  const ts = new Date().toLocaleTimeString();
  process.stderr.write(`[${ts}] ⚠️  ${agent}: ${msg}\n`);
};

// ── HTTP ────────────────────────────────────────────────────────────────────
async function mc(method, path_, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['x-api-key'] = API_KEY;
  const opts = { method, headers, signal: AbortSignal.timeout(15_000) };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${MC_URL}${path_}`, opts);
  if (!res.ok && res.status !== 404) throw new Error(`MC ${method} ${path_} → ${res.status}`);
  return res.ok ? res.json().catch(() => null) : null;
}

async function ollama(model, system, user) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature: 0.4, num_predict: 2048 },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  return (data?.message?.content || '').trim();
}

// ── Heartbeat ────────────────────────────────────────────────────────────────
async function heartbeat(agentName, status = 'idle', activity = '') {
  const agent = AGENTS[agentName];
  if (!agent) return;
  try {
    await mc('POST', `/api/agents/${agent.id}/heartbeat`, {
      status,
      last_activity: activity || `${agentName} heartbeat`,
    });
  } catch (e) {
    err(agentName, `Heartbeat failed: ${e.message}`);
  }
}

// ── Activity post ────────────────────────────────────────────────────────────
async function postActivity(agentName, message, type = 'info') {
  const agent = AGENTS[agentName];
  try {
    await mc('POST', '/api/activities', {
      type: 'agent_activity',
      entity_type: 'agent',
      entity_id: agent?.id,
      actor: agentName,
      description: message,
      metadata: { level: type, source: 'daemon' },
    });
  } catch {
    // Activity posting is best-effort
  }
}

// ── Portfolio work ───────────────────────────────────────────────────────────
async function runPortfolioPick(agentName) {
  log(agentName, 'Generating pick via Ollama...');
  await heartbeat(agentName, 'active', 'Generating pick');

  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'agent-portfolio-runner.cjs'),
    '--agent', agentName, '--execute',
  ], {
    env: { ...process.env, MC_API_KEY: API_KEY, MC_URL },
    encoding: 'utf8',
    timeout: 240_000,
  });

  try {
    const jsonStart = (result.stdout || '').indexOf('{');
    if (jsonStart >= 0) {
      const out = JSON.parse(result.stdout.slice(jsonStart));
      if (out.status === 'PASS' && out.pick) {
        const msg = `${agentName} pick: ${out.pick.description} ($${out.pick.amount})`;
        log(agentName, msg);
        await postActivity(agentName, msg, 'info');
      } else if (out.error) {
        err(agentName, `Pick failed: ${out.error}`);
      }
    }
  } catch {
    err(agentName, 'Failed to parse pick result');
  }
}

async function runMarketResearch(agentName) {
  const isTrading = agentName === 'TradingDesk';
  const model = isTrading ? 'deepseek-r1:latest' : 'deepseek-r1:latest';
  const system = 'You are a concise financial analyst. Output 2-3 bullet points only.';
  const userMsg = isTrading
    ? `Give 2-3 brief pre-market observations for today ${new Date().toLocaleDateString()}. Focus on major movers and macro. Be specific and brief.`
    : `Give 2-3 brief sports betting insights for today ${new Date().toLocaleDateString()}. Focus on injury news, line moves, or value angles. Be specific and brief.`;

  log(agentName, 'Running market research...');
  await heartbeat(agentName, 'active', 'Analyzing market');

  try {
    const analysis = await ollama(model, system, userMsg);
    const stripped = analysis.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (stripped) {
      log(agentName, `Research complete (${stripped.length} chars)`);
      await postActivity(agentName, `📊 ${agentName} analysis:\n${stripped.slice(0, 400)}`, 'info');
    }
  } catch (e) {
    err(agentName, `Research failed: ${e.message}`);
  }
}

// ── Governance work ──────────────────────────────────────────────────────────
async function runGovernanceScan(agentName) {
  log(agentName, 'Running governance scan...');
  await heartbeat(agentName, 'active', 'Running governance scan');

  try {
    const stewardResult = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'systems-steward.cjs'), 'status',
    ], { encoding: 'utf8', timeout: 30_000 });

    if (stewardResult.status === 0) {
      const jsonStart = stewardResult.stdout.indexOf('{');
      const out = jsonStart >= 0 ? JSON.parse(stewardResult.stdout.slice(jsonStart)) : null;
      const warnings = out?.warnings || [];
      const status = out?.status || 'UNKNOWN';
      const msg = `🏛 Governance scan: ${status}${warnings.length ? ` — ${warnings.length} warnings` : ' — all clear'}`;
      log(agentName, msg);
      await postActivity(agentName, msg, status === 'PASS' ? 'info' : 'warn');
    }
  } catch (e) {
    err(agentName, `Governance scan failed: ${e.message}`);
  }
}

async function runTestValidation(agentName) {
  log(agentName, 'Checking test coverage...');
  await heartbeat(agentName, 'active', 'Validating tests');

  try {
    const auditor = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'test-coverage-auditor.cjs'), 'audit',
    ], { encoding: 'utf8', timeout: 30_000 });

    if (auditor.status === 0) {
      const jsonStart = auditor.stdout.indexOf('{');
      const out = jsonStart >= 0 ? JSON.parse(auditor.stdout.slice(jsonStart)) : null;
      const score = out?.metadata?.coverage_score ?? '?';
      const msg = `✅ Coverage audit: ${score}% coverage score`;
      log(agentName, msg);
      await postActivity(agentName, msg, score >= 80 ? 'info' : 'warn');
    }
  } catch (e) {
    err(agentName, `Test validation failed: ${e.message}`);
  }
}

async function runSecurityCheck(agentName) {
  log(agentName, 'Running security governance check...');
  await heartbeat(agentName, 'active', 'Security check');

  try {
    const secResult = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'security-governor.cjs'),
    ], { encoding: 'utf8', timeout: 30_000 });

    if (secResult.status === 0) {
      const jsonStart = secResult.stdout.indexOf('{');
      const out = jsonStart >= 0 ? JSON.parse(secResult.stdout.slice(jsonStart)) : null;
      const status = out?.status || 'UNKNOWN';
      const msg = `🔒 Security check: ${status}`;
      log(agentName, msg);
      await postActivity(agentName, msg, status === 'PASS' ? 'info' : 'warn');
    }
  } catch (e) {
    err(agentName, `Security check failed: ${e.message}`);
  }
}

// ── Work scheduler ────────────────────────────────────────────────────────────
function shouldRunPortfolioPick(agentName) {
  const h = new Date().getHours();
  const day = new Date().getDay();
  if (agentName === 'TradingDesk' && (day === 0 || day === 6)) return false;
  const triggerHour = agentName === 'SportsClaw' ? 9 : 8;
  return h === triggerHour;
}

function shouldRunResearch(agentName) {
  const h = new Date().getHours();
  // Research runs every 6 hours during waking hours
  return h % 6 === 0 && h >= 6 && h <= 22;
}

function shouldRunGovernance(agentName) {
  const h = new Date().getHours();
  const min = new Date().getMinutes();
  // Governance runs every 2 hours, on the hour (within 5-min window)
  return h % 2 === 0 && min < 5;
}

// Tracks last-run times per agent+task to avoid double-firing
const lastRun = {};
function shouldFire(key, cooldownMs) {
  const now = Date.now();
  if (!lastRun[key] || now - lastRun[key] >= cooldownMs) {
    lastRun[key] = now;
    return true;
  }
  return false;
}

// ── Main work loop ────────────────────────────────────────────────────────────
async function workLoop(agentName) {
  const agent = AGENTS[agentName];

  // Always heartbeat
  await heartbeat(agentName, 'idle', `${agentName} online`);

  if (agent.type === 'portfolio') {
    // Pick generation — once per trigger hour, with 55-min cooldown
    if (shouldRunPortfolioPick(agentName) && shouldFire(`${agentName}_pick`, 55 * 60_000)) {
      await runPortfolioPick(agentName);
      await heartbeat(agentName, 'idle', 'Pick generated');
      return;
    }
    // Market research — every 6 hours
    if (shouldRunResearch(agentName) && shouldFire(`${agentName}_research`, 5 * 60 * 60_000)) {
      await runMarketResearch(agentName);
      await heartbeat(agentName, 'idle', 'Research complete');
      return;
    }
  }

  if (agent.type === 'governance') {
    if (agentName === 'SysBot' && shouldRunGovernance(agentName) && shouldFire(`${agentName}_gov`, 100 * 60_000)) {
      await runGovernanceScan(agentName);
      await heartbeat(agentName, 'idle', 'Governance scan complete');
    } else if (agentName === 'Coder' && shouldRunGovernance(agentName) && shouldFire(`${agentName}_test`, 100 * 60_000)) {
      await runTestValidation(agentName);
      await heartbeat(agentName, 'idle', 'Test validation complete');
    } else if (agentName === 'SecurityBot' && shouldRunGovernance(agentName) && shouldFire(`${agentName}_sec`, 100 * 60_000)) {
      await runSecurityCheck(agentName);
      await heartbeat(agentName, 'idle', 'Security check complete');
    }
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
function parseArgs(argv = process.argv.slice(2)) {
  const opts = { agents: Object.keys(AGENTS), once: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agents' && argv[i + 1]) {
      opts.agents = argv[i + 1].split(',').map(s => s.trim()).filter(s => AGENTS[s]);
      i++;
    }
    if (argv[i] === '--once') opts.once = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  process.stdout.write(`
╔══════════════════════════════════════════════════════╗
║          Mission Control Agent Daemon v1             ║
║  Agents: ${opts.agents.join(', ').padEnd(44)}║
║  MC:     ${MC_URL.padEnd(44)}║
╚══════════════════════════════════════════════════════╝
\n`);

  if (!API_KEY) {
    process.stderr.write('⚠️  No API_KEY set. Heartbeats will fail auth. Set API_KEY env var.\n');
  }

  // Initial heartbeat for all managed agents
  for (const agentName of opts.agents) {
    log(agentName, 'Starting up...');
    await heartbeat(agentName, 'idle', `${agentName} daemon started`);
  }
  process.stdout.write('\n✓ All agents online. Running work loops...\n\n');

  if (opts.once) {
    for (const agentName of opts.agents) {
      await workLoop(agentName);
    }
    return;
  }

  // Per-agent interval loops
  for (const agentName of opts.agents) {
    const agent = AGENTS[agentName];
    // Stagger start times to avoid thundering herd
    const stagger = Object.keys(AGENTS).indexOf(agentName) * 8_000;
    setTimeout(() => {
      workLoop(agentName).catch(e => err(agentName, e.message));
      setInterval(() => {
        workLoop(agentName).catch(e => err(agentName, e.message));
      }, agent.heartbeat_interval_ms);
    }, stagger);
  }

  // Keep alive
  process.on('SIGINT', () => {
    process.stdout.write('\n🛑 Daemon stopping — sending offline status...\n');
    Promise.all(opts.agents.map(a => heartbeat(a, 'offline', 'Daemon stopped'))).then(() => process.exit(0));
  });
}

module.exports = { AGENTS, heartbeat, workLoop, parseArgs, runPortfolioPick, runGovernanceScan };

if (require.main === module) {
  main().catch(e => { process.stderr.write(`Fatal: ${e.message}\n`); process.exit(1); });
}
