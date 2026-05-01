import { NextRequest, NextResponse } from 'next/server'
import { review, markOutcome } from '@/lib/server/memory-api-wrapper'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const source = searchParams.get('source') || 'cli'
    const limit = Math.min(300, Math.max(1, Number(searchParams.get('limit') || 300)))

    const data = await review({ limit, source })
    return NextResponse.json(data, { status: 200 })
  } catch (error) {
    console.error('Memory review error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST: light actions — demote or mark junk via existing markOutcome
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      action: 'demote' | 'mark_junk'
      id: number
    }

    if (!body.id || typeof body.id !== 'number') {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }
    if (!['demote', 'mark_junk'].includes(body.action)) {
      return NextResponse.json({ error: 'action must be demote or mark_junk' }, { status: 400 })
    }

    // Both actions append a failure signal via the existing markOutcome path
    const result = await markOutcome(body.id, 'failure', {
      usedPatterns: [body.id],
      primaryPatternId: body.id,
      runId: `review_${body.action}_${Date.now()}`,
    })

    return NextResponse.json({ ok: true, action: body.action, ...result }, { status: 200 })
  } catch (error) {
    console.error('Memory review action error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
