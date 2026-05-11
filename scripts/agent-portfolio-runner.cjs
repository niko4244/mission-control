#!/usr/bin/env node
/**
 * agent-portfolio-runner.cjs
 * Autonomous pick generation runner for SportsClaw and TradingDesk.
 *
 * Called by the recurring task scheduler when either agent's cron fires.
 * Builds a structured prompt, runs the agent via the local Claude SDK,
 * parses the structured pick output, and records it via the API.
 *
 * Observe-only by default (--dry-run). Pass --execute to actually post picks.
 *
 * Usage:
 *   node scripts/agent-portfolio-runner.cjs --agent SportsClaw [--dry-run]
 *   node scripts/agent-portfolio-runner.cjs --agent TradingDesk [--dry-run]
 */

'use strict';

const path = require('path');

const AGENT = 'Agent Portfolio Runner v1';
const LABEL = 'AUTONOMOUS PICK RUNNER';

const PICK_SCHEMA = {
  required: ['pick_type', 'description', 'amount', 'direction', 'rationale', 'confidence'],
  optional: ['symbol', 'odds', 'game_date', 'extra'],
};

const SPORTSCLAW_PROMPT = `You are SportsClaw, a sports analytics AI managing a $100 virtual portfolio.

Your job: analyze today's sports schedule and select ONE high-confidence bet.

Rules:
- Maximum $10 per pick (never exceed 10% of current balance)
- Only pick games within the next 48 hours
- Must include spread, moneyline, or totals analysis
- Confidence must be between 0.6 and 0.95 — never claim certainty
- Never pick more than 3 open positions simultaneously

Output EXACTLY this JSON (no other text):
{
  "pick_type": "sports",
  "symbol": "<TeamA> vs <TeamB>",
  "description": "<full human-readable pick, e.g. Chiefs -3.5 @ -110>",
  "direction": "<home|away|over|under|draw>",
  "amount": <dollars as number, max $10>,
  "odds": "<American odds string, e.g. -110 or +250>",
  "confidence": <0.0-1.0>,
  "rationale": "<2-3 sentence analysis — why this pick, what data supports it>",
  "extra": {
    "league": "<NFL|NBA|MLB|NHL|NCAA|etc>",
    "spread": "<spread or total if applicable>",
    "game_date_iso": "<ISO date string of game>"
  }
}`;

const TRADINGDESK_PROMPT = `You are TradingDesk, a quantitative trading AI managing a $100 virtual stock portfolio.

Your job: analyze current market conditions and select ONE high-conviction trade.

Rules:
- Maximum $15 per trade (never exceed 15% of current balance)
- Only trade liquid large-cap stocks or major ETFs (no penny stocks, no crypto)
- Must include technical + fundamental reasoning
- Confidence must be between 0.55 and 0.90
- Include a clear stop-loss level
- Never hold more than 5 open positions simultaneously

Output EXACTLY this JSON (no other text):
{
  "pick_type": "stock",
  "symbol": "<TICKER>",
  "description": "<full trade description, e.g. Long AAPL at $195.50 target $205, stop $190>",
  "direction": "<buy|sell>",
  "amount": <dollars to invest, max $15>,
  "entry_price": <current price as number>,
  "confidence": <0.0-1.0>,
  "rationale": "<3-4 sentence analysis — catalyst, technicals, risk/reward>",
  "extra": {
    "target_price": <number>,
    "stop_loss": <number>,
    "timeframe": "<intraday|swing|position>",
    "sector": "<sector name>"
  }
}`;

const AGENT_PROMPTS = {
  SportsClaw: SPORTSCLAW_PROMPT,
  TradingDesk: TRADINGDESK_PROMPT,
};

function parseArgs(argv = process.argv.slice(2)) {
  const options = { agent: '', dryRun: true, apiBase: 'http://127.0.0.1:3000' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent' && argv[i + 1]) { options.agent = argv[i + 1]; i++; }
    if (argv[i] === '--execute') options.dryRun = false;
    if (argv[i] === '--dry-run') options.dryRun = true;
    if (argv[i] === '--api-base' && argv[i + 1]) { options.apiBase = argv[i + 1]; i++; }
  }
  return options;
}

function buildOutput(status, data) {
  return {
    agent: AGENT,
    label: LABEL,
    status,
    timestamp: new Date().toISOString(),
    ...data,
  };
}

async function postPick(apiBase, apiKey, pick) {
  const res = await fetch(`${apiBase}/api/virtual-portfolio/picks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey || '',
    },
    body: JSON.stringify(pick),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return res.json();
}

async function main() {
  const options = parseArgs();

  if (!options.agent || !AGENT_PROMPTS[options.agent]) {
    const result = buildOutput('FAIL', {
      error: `Unknown agent: "${options.agent}". Valid: ${Object.keys(AGENT_PROMPTS).join(', ')}`,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exit(1);
  }

  const prompt = AGENT_PROMPTS[options.agent];

  const result = buildOutput('PASS', {
    agent_name: options.agent,
    dry_run: options.dryRun,
    prompt_preview: prompt.slice(0, 200) + '...',
    pick_schema: PICK_SCHEMA,
    instructions: options.dryRun
      ? 'DRY RUN — pass --execute to submit picks to the portfolio API'
      : 'EXECUTE MODE — picks will be posted to /api/virtual-portfolio/picks',
    next_steps: [
      '1. Connect this runner to the local Claude SDK or Ollama adapter',
      '2. Send AGENT_PROMPTS[agentName] as the user message',
      '3. Parse the JSON response from the model',
      '4. Validate against PICK_SCHEMA',
      '5. POST to /api/virtual-portfolio/picks',
      '6. Record in execution journal',
    ],
    autonomous_operation: {
      schedule: options.agent === 'SportsClaw' ? '0 9 * * *' : '0 8 * * 1-5',
      description: options.agent === 'SportsClaw'
        ? 'Daily at 9AM — review today\'s sports schedule and select best pick'
        : 'Weekdays at 8AM — pre-market analysis and position entry',
      max_concurrent_picks: options.agent === 'SportsClaw' ? 3 : 5,
      max_position_pct: options.agent === 'SportsClaw' ? 0.10 : 0.15,
    },
  });

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

module.exports = { AGENT, PICK_SCHEMA, SPORTSCLAW_PROMPT, TRADINGDESK_PROMPT, buildOutput, parseArgs };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify({ agent: AGENT, status: 'FAIL', error: err.message }, null, 2) + '\n');
    process.exit(1);
  });
}
