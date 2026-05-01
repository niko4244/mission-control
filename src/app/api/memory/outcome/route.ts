import { NextRequest, NextResponse } from 'next/server'
import { markOutcome } from '@/lib/server/memory-api-wrapper'

interface OutcomeRequest {
  id: number
  outcome: 'success' | 'failure' | 'unknown'
  usedPatterns: string
  primaryPatternId: number
  runId: string
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as OutcomeRequest

    // Validate inputs
    if (!body.id || Number.isNaN(body.id)) {
      return NextResponse.json({ error: 'Memory ID is required' }, { status: 400 })
    }
    if (!['success', 'failure', 'unknown'].includes(body.outcome)) {
      return NextResponse.json({ error: 'Outcome must be success, failure, or unknown' }, { status: 400 })
    }
    if (!body.primaryPatternId || Number.isNaN(body.primaryPatternId)) {
      return NextResponse.json({ error: 'Primary pattern ID is required' }, { status: 400 })
    }

    // Parse usedPatterns (optional)
    let usedPatterns: number[] = []
    if (body.usedPatterns) {
      try {
        usedPatterns = body.usedPatterns
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean)
          .map((s: string) => Number(s))
          .filter((n: number) => !Number.isNaN(n))
      } catch {
        return NextResponse.json({ error: 'Invalid usedPatterns format' }, { status: 400 })
      }
    }

    // Call memory-api
    const data = await markOutcome(body.id, body.outcome, {
      usedPatterns,
      primaryPatternId: body.primaryPatternId,
      runId: body.runId || undefined,
    })

    // Handle no results
    if (!data.updated) {
      return NextResponse.json({ error: data.reason || 'Failed to update outcome' }, { status: 400 })
    }

    return NextResponse.json({
      ...data,
      usedPatterns,
    })
  } catch (error) {
    console.error('Memory outcome error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
