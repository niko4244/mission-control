import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'

// GET /api/virtual-portfolio?agentId=4
// Returns portfolio summary + recent picks for one or all portfolio agents
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { searchParams } = new URL(request.url)
  const agentIdParam = searchParams.get('agentId')

  const db = getDatabase()

  const portfolios = agentIdParam
    ? db.prepare('SELECT * FROM virtual_portfolios WHERE agent_id = ?').all(Number(agentIdParam))
    : db.prepare('SELECT * FROM virtual_portfolios ORDER BY agent_id').all()

  const result = (portfolios as Record<string, unknown>[]).map((p) => {
    const agentId = p.agent_id as number
    const picks = db.prepare(`
      SELECT * FROM virtual_picks WHERE agent_id = ?
      ORDER BY pick_date DESC LIMIT 20
    `).all(agentId) as Record<string, unknown>[]

    const openPicks = db.prepare(`
      SELECT * FROM virtual_picks WHERE agent_id = ? AND status = 'open'
      ORDER BY pick_date DESC
    `).all(agentId) as Record<string, unknown>[]

    const roi = p.starting_balance as number > 0
      ? (((p.current_balance as number) - (p.starting_balance as number)) / (p.starting_balance as number)) * 100
      : 0

    return {
      ...p,
      roi_pct: Math.round(roi * 100) / 100,
      recent_picks: picks,
      open_picks: openPicks,
    }
  })

  return NextResponse.json(result)
}

// POST /api/virtual-portfolio  — seed or upsert a portfolio for an agent
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const body = await request.json() as {
    agent_id: number
    agent_name: string
    portfolio_type?: string
    starting_balance?: number
  }

  if (!body.agent_id || !body.agent_name) {
    return NextResponse.json({ error: 'agent_id and agent_name required' }, { status: 400 })
  }

  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  const balance = body.starting_balance ?? 100.00

  db.prepare(`
    INSERT INTO virtual_portfolios (agent_id, agent_name, starting_balance, current_balance, portfolio_type, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      agent_name = excluded.agent_name,
      portfolio_type = excluded.portfolio_type,
      updated_at = excluded.updated_at
  `).run(body.agent_id, body.agent_name, balance, balance, body.portfolio_type ?? 'general', now, now)

  const portfolio = db.prepare('SELECT * FROM virtual_portfolios WHERE agent_id = ?').get(body.agent_id)
  return NextResponse.json(portfolio, { status: 201 })
}
