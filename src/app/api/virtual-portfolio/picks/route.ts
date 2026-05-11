import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'

// GET /api/virtual-portfolio/picks?agentId=4&status=open&limit=50
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const agentId = searchParams.get('agentId')
  const status = searchParams.get('status')
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 200)

  const db = getDatabase()
  let query = 'SELECT * FROM virtual_picks WHERE 1=1'
  const params: (string | number)[] = []

  if (agentId) { query += ' AND agent_id = ?'; params.push(Number(agentId)) }
  if (status) { query += ' AND status = ?'; params.push(status) }
  query += ' ORDER BY pick_date DESC LIMIT ?'
  params.push(limit)

  const picks = db.prepare(query).all(...params)
  return NextResponse.json(picks)
}

// POST /api/virtual-portfolio/picks — record a new pick from an agent
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json() as {
    agent_id: number
    agent_name: string
    pick_type: 'stock' | 'sports'
    symbol?: string
    description: string
    direction?: string
    amount: number
    entry_price?: number
    odds?: string
    confidence?: number
    rationale?: string
    game_date?: number
    extra?: Record<string, unknown>
  }

  if (!body.agent_id || !body.description || !body.amount || !body.pick_type) {
    return NextResponse.json({ error: 'agent_id, description, amount, pick_type required' }, { status: 400 })
  }

  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)

  // Deduct amount from portfolio balance
  const portfolio = db.prepare('SELECT * FROM virtual_portfolios WHERE agent_id = ?').get(body.agent_id) as {
    current_balance: number; trade_count: number
  } | undefined

  if (!portfolio) {
    return NextResponse.json({ error: 'Portfolio not found for this agent. Create it first.' }, { status: 404 })
  }
  if (portfolio.current_balance < body.amount) {
    return NextResponse.json({ error: 'Insufficient balance', balance: portfolio.current_balance }, { status: 422 })
  }

  const result = db.prepare(`
    INSERT INTO virtual_picks
      (agent_id, agent_name, pick_type, symbol, description, direction, amount,
       entry_price, odds, confidence, rationale, game_date, extra, pick_date, workspace_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    body.agent_id, body.agent_name, body.pick_type,
    body.symbol ?? null, body.description, body.direction ?? null, body.amount,
    body.entry_price ?? null, body.odds ?? null,
    body.confidence ?? null, body.rationale ?? null,
    body.game_date ?? null,
    body.extra ? JSON.stringify(body.extra) : null,
    now
  )

  // Deduct from balance and increment trade count
  db.prepare(`
    UPDATE virtual_portfolios
    SET current_balance = current_balance - ?,
        trade_count = trade_count + 1,
        updated_at = ?
    WHERE agent_id = ?
  `).run(body.amount, now, body.agent_id)

  const pick = db.prepare('SELECT * FROM virtual_picks WHERE id = ?').get(result.lastInsertRowid)
  return NextResponse.json(pick, { status: 201 })
}

// PATCH /api/virtual-portfolio/picks — resolve a pick (won/lost/push/closed)
export async function PATCH(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json() as {
    id: number
    status: 'won' | 'lost' | 'push' | 'closed' | 'cancelled'
    exit_price?: number
    pnl?: number
  }

  if (!body.id || !body.status) {
    return NextResponse.json({ error: 'id and status required' }, { status: 400 })
  }

  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  const pick = db.prepare('SELECT * FROM virtual_picks WHERE id = ?').get(body.id) as {
    id: number; agent_id: number; amount: number; status: string
  } | undefined

  if (!pick) return NextResponse.json({ error: 'Pick not found' }, { status: 404 })
  if (pick.status !== 'open') return NextResponse.json({ error: 'Pick already resolved' }, { status: 409 })

  const pnl = body.pnl ?? (body.status === 'won' ? body.exit_price ?? 0 : body.status === 'push' ? 0 : -pick.amount)
  const roi = pick.amount > 0 ? (pnl / pick.amount) * 100 : 0
  const returned = pick.amount + pnl  // money returned to balance (0 if lost)

  db.prepare(`
    UPDATE virtual_picks SET status = ?, exit_price = ?, pnl = ?, roi_pct = ?, close_date = ?
    WHERE id = ?
  `).run(body.status, body.exit_price ?? null, pnl, Math.round(roi * 100) / 100, now, body.id)

  // Return money to portfolio (amount + pnl) and update win/loss
  const isWin = pnl > 0
  const isLoss = pnl < 0 && body.status !== 'cancelled'
  db.prepare(`
    UPDATE virtual_portfolios
    SET current_balance = current_balance + ?,
        realized_pnl = realized_pnl + ?,
        win_count = win_count + ?,
        loss_count = loss_count + ?,
        updated_at = ?
    WHERE agent_id = ?
  `).run(
    body.status === 'cancelled' ? pick.amount : returned,
    body.status === 'cancelled' ? 0 : pnl,
    isWin ? 1 : 0,
    isLoss ? 1 : 0,
    now,
    pick.agent_id
  )

  const updated = db.prepare('SELECT * FROM virtual_picks WHERE id = ?').get(body.id)
  return NextResponse.json(updated)
}
