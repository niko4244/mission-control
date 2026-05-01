import { NextRequest, NextResponse } from 'next/server'
import { status } from '@/lib/server/memory-api-wrapper'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const data = await status()

    return NextResponse.json(data, { status: 200 })
  } catch (error) {
    console.error('Memory status error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
