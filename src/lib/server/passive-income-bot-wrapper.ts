/**
 * Server-side wrapper for passive-income-bot.cjs
 *
 * Uses the same createRequire pattern as memory-api-wrapper.ts so Turbopack
 * does not attempt to statically bundle the CJS script at build time.
 */

import { createRequire } from 'node:module'

const _cjsLoad = createRequire(import.meta.url)
// 3 levels up from src/lib/server/ → project root → scripts/
const _bot = _cjsLoad('../../../scripts/passive-income-bot.cjs')

export interface EvidenceSignals {
  competitor_count?: number
  review_complaints?: string[]
  price_points?: number[]
  search_phrases?: string[]
  notes?: string[]
}

export interface PassiveIncomeBotInput {
  niche: string
  task_id?: string
  evidence_signals?: EvidenceSignals
  _dry_run?: boolean
}

export interface PassiveIncomeBotScores {
  demand: number
  buyer_pain: number
  competition_weakness: number
  differentiation: number
  ease_of_production: number
  visual_sales_potential: number
  evergreen_value: number
  price_potential: number
  maintenance_burden: number
}

export interface PassiveIncomeBotBrief {
  product_idea: string
  buyer: string
  pain_point: string
  evidence_summary: string
  evidence_basis: 'heuristic_only' | 'user_supplied_signals'
  evidence_signals_used: Partial<EvidenceSignals> | null
  scores: PassiveIncomeBotScores
  recommendation: string
  next_action: string
}

export type BotStatus = 'DRAFT_CREATED' | 'WATCH' | 'REJECTED'

export interface PassiveIncomeBotResult {
  status: BotStatus
  risk_level: 1
  label: 'DRAFT — NOT APPROVED'
  brief: PassiveIncomeBotBrief
  evidence_entry_id: string | null
}

export interface PassiveIncomeBotError {
  error: string
  status: 400
}

export type PassiveIncomeBotOutput = PassiveIncomeBotResult | PassiveIncomeBotError

export function runBot(input: PassiveIncomeBotInput): PassiveIncomeBotOutput {
  return (_bot.run as (i: PassiveIncomeBotInput) => PassiveIncomeBotOutput)(input)
}
