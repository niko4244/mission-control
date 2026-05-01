import { NextRequest, NextResponse } from 'next/server'
import { recall } from '@/lib/server/memory-api-wrapper'

interface RecallRequest {
  prompt: string
  agent: string
  limit: number
  runId: string
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as RecallRequest

    // Validate inputs
    if (!body.prompt || typeof body.prompt !== 'string') {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 })
    }
    if (!body.agent || typeof body.agent !== 'string') {
      return NextResponse.json({ error: 'Agent is required' }, { status: 400 })
    }
    if (!body.limit || Number.isNaN(body.limit)) {
      return NextResponse.json({ error: 'Limit must be a number' }, { status: 400 })
    }
    if (body.limit < 1 || body.limit > 50) {
      return NextResponse.json({ error: 'Limit must be between 1 and 50' }, { status: 400 })
    }

    // Call memory-api
    const data = await recall(body.agent, {
      prompt: body.prompt,
      limit: body.limit,
      runId: body.runId || undefined,
    })

    // Check for no results
    if (data.selected.length === 0 && data.usedPatterns.length === 0) {
      return NextResponse.json({ error: 'No memories found for this prompt' }, { status: 404 })
    }

    return NextResponse.json(data, { status: 200 })
  } catch (error) {
    console.error('Memory recall error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
