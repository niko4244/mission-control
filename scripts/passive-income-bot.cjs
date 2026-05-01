#!/usr/bin/env node
/**
 * Passive Income Bot v1.1
 * Risk level: 1 (Draft / Research only)
 *
 * Accepts a niche/topic, applies heuristic scoring across 9 dimensions,
 * writes an evidence log entry, and returns a structured opportunity brief.
 *
 * NEVER publishes, spends money, contacts external parties, or triggers
 * financial action. All outputs are labeled DRAFT — NOT APPROVED.
 *
 * Output states: DRAFT_CREATED | WATCH | REJECTED
 */

'use strict';

// ============================================================================
// CONSTANTS
// ============================================================================

const RISK_LEVEL = 1;
const LABEL = 'DRAFT — NOT APPROVED';
const BOT_SOURCE = 'passive-income-bot';

// Score thresholds (max total is 90 = 9 criteria × 10)
const DRAFT_THRESHOLD = 55;
const WATCH_THRESHOLD = 40;

const CRITERIA = [
  'demand',
  'buyer_pain',
  'competition_weakness',
  'differentiation',
  'ease_of_production',
  'visual_sales_potential',
  'evergreen_value',
  'price_potential',
  'maintenance_burden',
];

// ============================================================================
// SCORING ENGINE
// ============================================================================

/**
 * Score a niche across 9 dimensions using pattern-based heuristics.
 * All scores are integers 0–10. No external API calls are made.
 */
function scoreNiche(niche) {
  const lower = niche.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const wordCount = words.length;

  // Format signals
  const isDownloadable = /pdf|printable|template|checklist|planner|worksheet|workbook|ebook|cheat.?sheet|spreadsheet|tracker|log\b|form\b|guide\b/.test(lower);
  const isPhysicalDomain = /repair|service|maintenance|inspection|diagnostic|troubleshoot|appliance|hvac|plumbing|electrical|auto|mechanic|install/.test(lower);
  const isSoftware = /\bapp\b|software|saas|plugin|extension|api\b|script\b|code/.test(lower);
  const isContentBusiness = /\bblog|podcast|video|course|newsletter|social media|influencer/.test(lower);
  const isProfessional = /professional|technician|contractor|freelance|business|entrepreneur|consultant/.test(lower);
  const isSpecific = wordCount >= 4; // longer niche = more specific
  const isVerySpecific = wordCount >= 6;

  // ── Demand (7 = solid niche, 4 = vague)
  let demand = 5;
  if (isDownloadable) demand += 2;
  if (isPhysicalDomain) demand += 1;
  if (isSoftware) demand -= 1;
  if (isContentBusiness) demand -= 1;
  demand = clamp(demand, 1, 10);

  // ── Buyer pain (higher when solving a real workflow problem)
  let buyer_pain = 5;
  if (isPhysicalDomain) buyer_pain += 3;
  if (isDownloadable) buyer_pain += 2;
  if (isProfessional) buyer_pain += 1;
  buyer_pain = clamp(buyer_pain, 1, 10);

  // ── Competition weakness (specific niches have fewer direct competitors)
  let competition_weakness = 4;
  if (isSpecific) competition_weakness += 3;
  if (isVerySpecific) competition_weakness += 1;
  if (isSoftware) competition_weakness -= 2;
  if (isContentBusiness) competition_weakness -= 2;
  competition_weakness = clamp(competition_weakness, 1, 10);

  // ── Differentiation (specific + downloadable = clearly differentiable)
  let differentiation = 4;
  if (isDownloadable && isSpecific) differentiation += 4;
  else if (isDownloadable) differentiation += 2;
  if (isProfessional) differentiation += 1;
  differentiation = clamp(differentiation, 1, 10);

  // ── Ease of production (PDF/template = easy; software = hard)
  let ease_of_production = 5;
  if (isDownloadable && !isSoftware) ease_of_production += 4;
  if (isSoftware) ease_of_production -= 3;
  if (isContentBusiness) ease_of_production -= 2;
  ease_of_production = clamp(ease_of_production, 1, 10);

  // ── Visual sales potential (downloadable products photograph/mockup well)
  let visual_sales_potential = 5;
  if (isDownloadable) visual_sales_potential += 3;
  if (isSoftware) visual_sales_potential -= 1;
  visual_sales_potential = clamp(visual_sales_potential, 1, 10);

  // ── Evergreen value (repair, maintenance, professional tools age slowly)
  let evergreen_value = 6;
  if (isPhysicalDomain || isDownloadable) evergreen_value += 3;
  if (isContentBusiness) evergreen_value -= 3;
  if (isSoftware) evergreen_value -= 2;
  evergreen_value = clamp(evergreen_value, 1, 10);

  // ── Price potential ($5–$50 range; professional tools command more)
  let price_potential = 5;
  if (isDownloadable) price_potential += 1;
  if (isProfessional) price_potential += 2;
  if (isSoftware) price_potential += 2;
  if (isVerySpecific) price_potential += 1;
  price_potential = clamp(price_potential, 1, 10);

  // ── Maintenance burden (low = good; PDF/template requires almost no upkeep)
  let maintenance_burden = 6;
  if (isDownloadable && !isSoftware) maintenance_burden += 3;
  if (isSoftware) maintenance_burden -= 4;
  if (isContentBusiness) maintenance_burden -= 2;
  maintenance_burden = clamp(maintenance_burden, 1, 10);

  return {
    demand,
    buyer_pain,
    competition_weakness,
    differentiation,
    ease_of_production,
    visual_sales_potential,
    evergreen_value,
    price_potential,
    maintenance_burden,
  };
}

function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

// ============================================================================
// EVIDENCE SIGNAL ADJUSTER
// ============================================================================

/**
 * Apply user-supplied evidence signals on top of heuristic scores.
 * Returns adjusted scores, the evidence basis label, and which signals were used.
 * Does not call any external API. Does not scrape. Pure data transformation.
 *
 * @param {object} scores  Base heuristic scores from scoreNiche()
 * @param {object} signals Optional evidence_signals from the caller
 */
function applyEvidenceSignals(scores, signals) {
  if (!signals || typeof signals !== 'object') {
    return { adjustedScores: { ...scores }, evidenceBasis: 'heuristic_only', signalsUsed: null };
  }

  const { competitor_count, review_complaints, price_points, search_phrases, notes } = signals;

  // Consider signals present only when at least one field has real content
  const hasContent =
    competitor_count !== undefined ||
    (Array.isArray(review_complaints) && review_complaints.length > 0) ||
    (Array.isArray(price_points) && price_points.length > 0) ||
    (Array.isArray(search_phrases) && search_phrases.length > 0) ||
    (Array.isArray(notes) && notes.length > 0);

  if (!hasContent) {
    return { adjustedScores: { ...scores }, evidenceBasis: 'heuristic_only', signalsUsed: null };
  }

  const adj = { ...scores };
  const used = {};

  // ── competitor_count ─────────────────────────────────────────────────────
  if (typeof competitor_count === 'number' && competitor_count >= 0) {
    used.competitor_count = competitor_count;
    if (competitor_count === 0) {
      adj.competition_weakness = clamp(adj.competition_weakness + 2, 1, 10);
      adj.demand = clamp(adj.demand - 1, 1, 10);
    } else if (competitor_count <= 20) {
      adj.demand = clamp(adj.demand + 1, 1, 10);
      adj.competition_weakness = clamp(adj.competition_weakness + 1, 1, 10);
    } else if (competitor_count <= 100) {
      adj.demand = clamp(adj.demand + 2, 1, 10);
      // competition_weakness unchanged per spec
    } else {
      adj.demand = clamp(adj.demand + 2, 1, 10);
      adj.competition_weakness = clamp(adj.competition_weakness - 2, 1, 10);
    }
  }

  // ── review_complaints: each meaningful complaint (up to 5) → +1 buyer_pain
  if (Array.isArray(review_complaints) && review_complaints.length > 0) {
    const meaningful = review_complaints
      .filter((c) => typeof c === 'string' && c.trim().length > 5)
      .slice(0, 5);
    if (meaningful.length > 0) {
      used.review_complaints = meaningful;
      adj.buyer_pain = clamp(adj.buyer_pain + meaningful.length, 1, 10);
    }
  }

  // ── price_points: average price drives price_potential adjustment
  if (Array.isArray(price_points) && price_points.length > 0) {
    const valid = price_points.filter((p) => typeof p === 'number' && p > 0);
    if (valid.length > 0) {
      used.price_points = valid;
      const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
      if (avg >= 12) {
        adj.price_potential = clamp(adj.price_potential + 2, 1, 10);
      } else if (avg >= 5) {
        adj.price_potential = clamp(adj.price_potential + 1, 1, 10);
      } else if (avg < 3) {
        adj.price_potential = clamp(adj.price_potential - 1, 1, 10);
      }
    }
  }

  // ── search_phrases: each specific phrase (up to 5) → +1 demand
  if (Array.isArray(search_phrases) && search_phrases.length > 0) {
    const valid = search_phrases
      .filter((p) => typeof p === 'string' && p.trim().length > 0)
      .slice(0, 5);
    if (valid.length > 0) {
      used.search_phrases = valid;
      adj.demand = clamp(adj.demand + valid.length, 1, 10);
    }
  }

  // ── notes: included in evidence_summary only, not scored
  if (Array.isArray(notes) && notes.length > 0) {
    const valid = notes.filter((n) => typeof n === 'string' && n.trim().length > 0);
    if (valid.length > 0) {
      used.notes = valid;
    }
  }

  return {
    adjustedScores: adj,
    evidenceBasis: 'user_supplied_signals',
    signalsUsed: used,
  };
}

// ============================================================================
// BRIEF GENERATOR
// ============================================================================

function buildBrief(niche, scores, evidenceBasis, signalsUsed) {
  const lower = niche.toLowerCase();
  const total = Object.values(scores).reduce((a, b) => a + b, 0);

  const isDownloadable = /pdf|printable|template|checklist|planner|worksheet|workbook|ebook|guide\b/.test(lower);
  const isPhysicalDomain = /repair|service|maintenance|inspection|appliance|hvac|plumbing|electrical|auto|mechanic/.test(lower);
  const isProfessional = /professional|technician|contractor|freelance|business|consultant/.test(lower);

  // Product idea
  let product_idea;
  if (isDownloadable && isPhysicalDomain) {
    product_idea = `Downloadable "${niche}" — a polished, field-ready PDF for tradespeople or technicians, sold on Etsy or Gumroad`;
  } else if (isDownloadable) {
    product_idea = `Downloadable "${niche}" — a structured PDF template sold on Etsy, Gumroad, or Payhip`;
  } else if (isPhysicalDomain) {
    product_idea = `Digital reference tool for "${niche}" — format (checklist, guide, or template) to be validated with buyers`;
  } else {
    product_idea = `Digital product targeting "${niche}" — format and pricing to be validated before production`;
  }

  // Buyer persona
  const buyer = isPhysicalDomain && isProfessional
    ? 'Tradespeople, repair technicians, or small service businesses'
    : isPhysicalDomain
    ? 'DIY homeowners and small appliance repair professionals'
    : isProfessional
    ? 'Freelancers, independent professionals, or small business owners'
    : 'Niche audience — buyer persona requires demand validation';

  // Pain point
  const pain_point = isPhysicalDomain
    ? `Missing or inconsistent documentation for "${niche}" workflows, leading to errors, callbacks, or missed steps`
    : `Time wasted on repetitive tasks or lack of structure in the "${niche}" space`;

  // Status and recommendation
  let status, recommendation, next_action;

  if (total >= DRAFT_THRESHOLD) {
    status = 'DRAFT_CREATED';
    recommendation = `Strong candidate (score ${total}/90). All core dimensions pass threshold. Proceed to demand validation before production.`;
    next_action = 'Find demand evidence: search volume data + 3 forum threads or customer reviews confirming this specific pain. Record findings as evidence log entries before starting production.';
  } else if (total >= WATCH_THRESHOLD) {
    status = 'WATCH';
    recommendation = `Moderate candidate (score ${total}/90). Some dimensions are weak. Do not invest production time until demand is confirmed.`;
    next_action = 'Identify the 2–3 lowest-scoring dimensions and gather specific evidence to raise them, or reframe the niche to be more specific and actionable.';
  } else {
    status = 'REJECTED';
    recommendation = `Low opportunity score (${total}/90). The niche is too vague, faces strong competition, or requires high production effort relative to revenue potential.`;
    next_action = 'Reframe: narrow the niche to a specific format (e.g., checklist over course), a specific audience (e.g., HVAC technicians vs. home repair), or a specific problem (e.g., annual inspection vs. general repair).';
  }

  let evidence_summary;
  if (evidenceBasis === 'user_supplied_signals' && signalsUsed) {
    const signalKeys = Object.keys(signalsUsed).join(', ');
    const notesText = Array.isArray(signalsUsed.notes) && signalsUsed.notes.length > 0
      ? ` Notes: ${signalsUsed.notes.join('; ')}.`
      : '';
    evidence_summary = `Signal-adjusted score: ${total}/90. Evidence basis: user-supplied signals (${signalKeys}).${notesText} Validation required before any production action.`;
  } else {
    evidence_summary = `Heuristic score: ${total}/90 across ${CRITERIA.length} dimensions. No live demand data gathered yet — this entry initiates the evidence loop. Validation required before any production action.`;
  }

  return {
    status,
    product_idea,
    buyer,
    pain_point,
    evidence_summary,
    evidence_basis: evidenceBasis,
    evidence_signals_used: signalsUsed,
    scores,
    recommendation,
    next_action,
  };
}

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Run the Passive Income Bot for a given niche.
 *
 * Options:
 *   niche            {string}  The niche/topic to evaluate (required)
 *   task_id          {string}  Optional Mission Control task ID
 *   evidence_signals {object}  Optional user-supplied research signals
 *   _dry_run         {boolean} When true, skip DB write (for tests)
 *
 * Returns either:
 *   { error, status: 400 }          — validation failure
 *   { status, risk_level, label, brief, evidence_entry_id }  — success
 */
function run(options = {}) {
  const { niche, task_id, _dry_run = false, evidence_signals } = options;

  // ── Input validation
  if (!niche || typeof niche !== 'string' || niche.trim().length === 0) {
    return { error: 'niche is required and must be a non-empty string', status: 400 };
  }
  if (niche.trim().length < 3) {
    return { error: 'niche must be at least 3 characters', status: 400 };
  }

  const trimmedNiche = niche.trim();

  // ── Score (heuristic base) then apply any user-supplied signals
  const baseScores = scoreNiche(trimmedNiche);
  const { adjustedScores, evidenceBasis, signalsUsed } = applyEvidenceSignals(baseScores, evidence_signals);
  const scores = adjustedScores;
  const brief = buildBrief(trimmedNiche, scores, evidenceBasis, signalsUsed);

  const runId = `pib_${Date.now()}`;
  let evidenceEntryId = null;

  // ── Write evidence log entry (skipped in dry-run / test mode)
  if (!_dry_run) {
    try {
      // Lazy require — keeps memory-api.cjs out of the module-load critical path
      // so tests that don't need a DB can import this module safely
      const memApi = require('./memory-api.cjs');
      const total = Object.values(scores).reduce((a, b) => a + b, 0);

      const entry = memApi.write({
        source: BOT_SOURCE,
        category: 'execution',
        content: [
          `Niche: ${trimmedNiche}`,
          `Output: ${brief.status}`,
          `Score: ${total}/90`,
          `Evidence basis: ${brief.evidence_basis}`,
          `Product idea: ${brief.product_idea}`,
          `Recommendation: ${brief.recommendation}`,
        ].join('\n'),
        tags: [
          'domain:passive-income',
          'evidence_type:opportunity_score',
          'outcome:unknown',
          'confidence:low',
        ].join(','),
        sourceRef: `source:${BOT_SOURCE}|run:${runId}`,
        agent: BOT_SOURCE,
        taskId: task_id ? Number(task_id) : null,
        runId,
      });

      evidenceEntryId = entry?.id != null ? String(entry.id) : null;
    } catch {
      // Evidence write is best-effort; bot result is still returned
      evidenceEntryId = null;
    }
  } else {
    // Dry-run mode: signal that write was intentionally skipped
    evidenceEntryId = 'dry-run';
  }

  return {
    status: brief.status,
    risk_level: RISK_LEVEL,
    label: LABEL,
    brief: {
      product_idea: brief.product_idea,
      buyer: brief.buyer,
      pain_point: brief.pain_point,
      evidence_summary: brief.evidence_summary,
      evidence_basis: brief.evidence_basis,
      evidence_signals_used: brief.evidence_signals_used,
      scores: brief.scores,
      recommendation: brief.recommendation,
      next_action: brief.next_action,
    },
    evidence_entry_id: evidenceEntryId,
  };
}

module.exports = { run, scoreNiche, DRAFT_THRESHOLD, WATCH_THRESHOLD, CRITERIA, LABEL, RISK_LEVEL };

// ============================================================================
// CLI ENTRY POINT
// Only executes when this file is run directly: node scripts/passive-income-bot.cjs
// ============================================================================

if (require.main === module) {
  const argv = process.argv.slice(2);

  // Parse --key value flags (flags without a value are set to true)
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }

  const niche = typeof flags['niche'] === 'string' ? flags['niche'] : '';
  const taskId = typeof flags['task-id'] === 'string' ? flags['task-id'] : undefined;
  const dryRun = flags['dry-run'] === true;

  // Parse --signals-json if supplied; invalid JSON exits nonzero immediately
  let evidenceSignals;
  if (typeof flags['signals-json'] === 'string') {
    try {
      evidenceSignals = JSON.parse(flags['signals-json']);
    } catch {
      process.stdout.write(
        JSON.stringify(
          { error: '--signals-json contains invalid JSON', status: 400 },
          null,
          2
        ) + '\n'
      );
      process.exit(1);
    }
  }

  const result = run({ niche, task_id: taskId, _dry_run: dryRun, evidence_signals: evidenceSignals });

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  // Exit nonzero when the bot returns a validation error
  if ('error' in result) {
    process.exit(1);
  }

  process.exit(0);
}
