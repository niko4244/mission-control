#!/usr/bin/env node
/**
 * agent-portfolio-runner.cjs
 * Autonomous pick generation for SportsClaw (sports) and TradingDesk (stocks).
 *
 * Calls Ollama /api/chat with a structured prompt, parses JSON pick output,
 * validates the schema, and POSTs to /api/virtual-portfolio/picks.
 *
 * Usage:
 *   node scripts/agent-portfolio-runner.cjs --agent SportsClaw [--dry-run]
 *   node scripts/agent-portfolio-runner.cjs --agent TradingDesk [--dry-run]
 *   node scripts/agent-portfolio-runner.cjs --agent SportsClaw --execute
 *
 * Scheduled via recurring tasks in the DB:
 *   SportsClaw:   0 9  * * *     (daily 9AM picks)
 *   TradingDesk:  0 8  * * 1-5   (weekday 8AM pre-market)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const AGENT_SCRIPT = 'Agent Portfolio Runner v1';
const LABEL = 'AUTONOMOUS PICK RUNNER';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MC_URL = process.env.MC_URL || 'http://127.0.0.1:3000';
const MC_API_KEY = process.env.MC_API_KEY || '';

// Agent IDs match database agents table
const AGENT_IDS = { SportsClaw: 4, TradingDesk: 15 };

// ── Agent-specific models ────────────────────────────────────────────────────
const AGENT_MODELS = {
  SportsClaw: process.env.SPORTSCLAW_MODEL || 'deepseek-r1:latest',
  TradingDesk: process.env.TRADINGDESK_MODEL || 'deepseek-r1:latest',
};

// ── Prompts ──────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT_BASE = `You are an expert analyst AI running inside Mission Control.
You output ONLY valid JSON. No explanation, no markdown, no code fences.
Your output will be parsed programmatically — any text outside the JSON object will cause a failure.`;

const SPORTSCLAW_USER_PROMPT = () => {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return `Today is ${today}.

You are SportsClaw, a sports analytics AI managing a virtual $100 portfolio.

Select ONE high-confidence sports pick for today or the next 24-48 hours.

Constraints:
- Amount: $5–$10 maximum (never more than 10% of $100 starting balance)
- Only pick games/events happening within the next 48 hours
- Include proper spread/moneyline/total analysis
- Confidence range: 0.60–0.90 (never claim certainty)
- Prefer underdogs with +value when the edge is clear

Output this EXACT JSON object (nothing else):
{
  "pick_type": "sports",
  "symbol": "<Team A> vs <Team B>",
  "description": "<full pick description, e.g. Lakers +4.5 vs Celtics @ -108>",
  "direction": "<home|away|over|under|draw>",
  "amount": <number 5-10>,
  "odds": "<American odds, e.g. -110 or +240>",
  "confidence": <number 0.60-0.90>,
  "rationale": "<2-3 sentences: why this pick, what stats/matchup factors support it>",
  "extra": {
    "league": "<NFL|NBA|MLB|NHL|NCAA|MMA|EPL|etc>",
    "bet_type": "<spread|moneyline|over_under|parlay>",
    "game_date_iso": "<YYYY-MM-DD>",
    "key_factor": "<the single most important reason for this pick>"
  }
}`;
};

const TRADINGDESK_USER_PROMPT = () => {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const hour = new Date().getHours();
  const session = hour < 9 ? 'pre-market' : hour < 16 ? 'market hours' : 'after-hours';
  return `Today is ${today}. Current session: ${session}.

You are TradingDesk, a quantitative trading AI managing a virtual $100 portfolio.

Select ONE high-conviction trade for today.

Constraints:
- Amount: $10–$15 maximum (never more than 15% of $100 starting balance)
- Large-cap stocks or major ETFs only (S&P 500 components, QQQ, SPY, sector ETFs)
- No penny stocks, no crypto, no leveraged ETFs
- Must include a clear stop-loss and price target
- Confidence range: 0.55–0.85
- Consider: recent earnings, macro environment, technical levels

Output this EXACT JSON object (nothing else):
{
  "pick_type": "stock",
  "symbol": "<TICKER>",
  "description": "<full trade, e.g. Long NVDA at $118.50, target $128, stop $114>",
  "direction": "<buy|sell>",
  "amount": <number 10-15>,
  "entry_price": <current price as number>,
  "confidence": <number 0.55-0.85>,
  "rationale": "<3-4 sentences: catalyst, technical setup, risk/reward reasoning>",
  "extra": {
    "target_price": <number>,
    "stop_loss": <number>,
    "timeframe": "<intraday|swing_2_5d|position_week>",
    "sector": "<sector name>",
    "catalyst": "<key driver for this trade>"
  }
}`;
};

// ── Ollama call ──────────────────────────────────────────────────────────────
async function callOllama(model, systemPrompt, userPrompt) {
  const payload = {
    model,
    stream: false,
    options: { temperature: 0.3, num_predict: 4096 },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(180000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama returned HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = (data?.message?.content || '').trim();
  if (!content) throw new Error('Ollama returned empty content');
  return content;
}

// ── Portfolio API call ────────────────────────────────────────────────────────
async function submitPick(agentName, agentId, pick) {
  const payload = { agent_id: agentId, agent_name: agentName, ...pick };
  const headers = { 'Content-Type': 'application/json', ...(MC_API_KEY ? { 'x-api-key': MC_API_KEY } : {}) };

  const res = await fetch(`${MC_URL}/api/virtual-portfolio/picks`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Portfolio API returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ── JSON extraction ──────────────────────────────────────────────────────────
function extractJson(text) {
  // Strip <think>...</think> blocks from deepseek-r1 reasoning
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // Try direct parse first
  try { return JSON.parse(stripped); } catch {}

  // Extract first {...} block
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  throw new Error(`Could not extract JSON from model output. Raw: ${stripped.slice(0, 300)}`);
}

// ── Schema validation ────────────────────────────────────────────────────────
function validatePick(pick, agentName) {
  const errors = [];
  if (!pick || typeof pick !== 'object') return ['Pick is not an object'];

  const required = ['pick_type', 'description', 'amount', 'direction', 'rationale', 'confidence'];
  for (const f of required) {
    if (pick[f] === undefined || pick[f] === null || pick[f] === '') errors.push(`Missing: ${f}`);
  }

  if (!['stock', 'sports'].includes(pick.pick_type)) errors.push(`Invalid pick_type: ${pick.pick_type}`);
  if (typeof pick.amount !== 'number' || pick.amount <= 0) errors.push('amount must be positive number');
  if (typeof pick.confidence !== 'number' || pick.confidence < 0 || pick.confidence > 1) {
    errors.push('confidence must be 0.0–1.0');
  }

  // Enforce max position sizes
  const maxAmount = agentName === 'SportsClaw' ? 10 : 15;
  if (pick.amount > maxAmount) {
    errors.push(`Amount $${pick.amount} exceeds max $${maxAmount} for ${agentName}`);
  }

  return errors;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function parseArgs(argv = process.argv.slice(2)) {
  const opts = { agent: '', dryRun: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent' && argv[i + 1]) { opts.agent = argv[i + 1]; i++; }
    if (argv[i] === '--execute') opts.dryRun = false;
    if (argv[i] === '--dry-run') opts.dryRun = true;
  }
  return opts;
}

async function run() {
  const opts = parseArgs();
  const startedAt = new Date().toISOString();

  if (!opts.agent || !AGENT_IDS[opts.agent]) {
    const out = { agent: AGENT_SCRIPT, status: 'FAIL', error: `Unknown agent: "${opts.agent}". Valid: ${Object.keys(AGENT_IDS).join(', ')}` };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(1);
  }

  const agentId = AGENT_IDS[opts.agent];
  const model = AGENT_MODELS[opts.agent];
  const userPrompt = opts.agent === 'SportsClaw' ? SPORTSCLAW_USER_PROMPT() : TRADINGDESK_USER_PROMPT();

  process.stderr.write(`[${AGENT_SCRIPT}] Running ${opts.agent} | model=${model} | dry_run=${opts.dryRun}\n`);

  let raw = '';
  let pick = null;
  let validationErrors = [];
  let submittedPick = null;
  let submitError = '';

  // Step 1: Call Ollama
  try {
    process.stderr.write(`[${AGENT_SCRIPT}] Calling Ollama...\n`);
    raw = await callOllama(model, SYSTEM_PROMPT_BASE, userPrompt);
    process.stderr.write(`[${AGENT_SCRIPT}] Got response (${raw.length} chars)\n`);
  } catch (err) {
    const out = { agent: AGENT_SCRIPT, label: LABEL, status: 'FAIL', agent_name: opts.agent, started_at: startedAt, error: `Ollama call failed: ${err.message}` };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(1);
  }

  // Step 2: Extract + validate JSON
  try {
    pick = extractJson(raw);
    validationErrors = validatePick(pick, opts.agent);
  } catch (err) {
    const out = { agent: AGENT_SCRIPT, label: LABEL, status: 'FAIL', agent_name: opts.agent, started_at: startedAt, raw_response: raw.slice(0, 500), error: `JSON extraction failed: ${err.message}` };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(1);
  }

  if (validationErrors.length > 0) {
    const out = { agent: AGENT_SCRIPT, label: LABEL, status: 'FAIL', agent_name: opts.agent, started_at: startedAt, pick, validation_errors: validationErrors };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(1);
  }

  // Step 3: Submit or dry-run
  if (!opts.dryRun) {
    try {
      process.stderr.write(`[${AGENT_SCRIPT}] Submitting pick to portfolio API...\n`);
      submittedPick = await submitPick(opts.agent, agentId, pick);
      process.stderr.write(`[${AGENT_SCRIPT}] Pick recorded: id=${submittedPick.id}\n`);
    } catch (err) {
      submitError = err.message;
    }
  }

  const out = {
    agent: AGENT_SCRIPT,
    label: LABEL,
    status: submitError ? 'FAIL' : 'PASS',
    agent_name: opts.agent,
    model,
    dry_run: opts.dryRun,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    pick,
    submitted: !opts.dryRun && !submitError,
    submitted_pick_id: submittedPick ? submittedPick.id : null,
    error: submitError || null,
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (submitError) process.exit(1);
}

module.exports = { AGENT_SCRIPT, AGENT_IDS, AGENT_MODELS, PICK_SCHEMA: { required: ['pick_type','description','amount','direction','rationale','confidence'] }, callOllama, extractJson, validatePick, parseArgs };

if (require.main === module) {
  run().catch((err) => {
    process.stderr.write(`[${AGENT_SCRIPT}] Fatal: ${err.message}\n`);
    process.exit(1);
  });
}
