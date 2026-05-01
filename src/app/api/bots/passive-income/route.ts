import { NextRequest, NextResponse } from 'next/server'
import { runBot, type PassiveIncomeBotError, type EvidenceSignals } from '@/lib/server/passive-income-bot-wrapper'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface PassiveIncomeRequest {
  niche: string
  task_id?: string
  evidence_signals?: EvidenceSignals
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as PassiveIncomeRequest

    if (!body.niche || typeof body.niche !== 'string') {
      return NextResponse.json(
        { error: 'niche is required and must be a string' },
        { status: 400 }
      )
    }
    if (body.niche.trim().length === 0) {
      return NextResponse.json(
        { error: 'niche must not be empty' },
        { status: 400 }
      )
    }
    if (body.niche.length > 500) {
      return NextResponse.json(
        { error: 'niche must be 500 characters or fewer' },
        { status: 400 }
      )
    }

    const result = runBot({
      niche: body.niche.trim(),
      task_id: body.task_id,
      evidence_signals: body.evidence_signals,
    })

    // Bot returned a validation error
    if ('error' in result) {
      return NextResponse.json(
        { error: (result as PassiveIncomeBotError).error },
        { status: 400 }
      )
    }

    return NextResponse.json(result, { status: 200 })
  } catch (error) {
    console.error('Passive income bot error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
