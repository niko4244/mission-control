import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireRole } from '@/lib/auth'

// PATCH /api/virtual-portfolio/picks/[id] — resolve a pick outcome
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { id } = await params
  const pickId = parseInt(id)
  if (isNaN(pickId)) return NextResponse.json({ error: 'Invalid pick id' }, { status: 400 })

  const body = await request.json() as {
    status: 'won' | 'lost' | 'push' | 'closed' | 'cancelled'
    exit_price?: number
    pnl?: number
  }

  if (!body.status) return NextResponse.json({ error: 'status required' }, { status: 400 })

  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  const pick = db.prepare('SELECT * FROM virtual_picks WHERE id = ?').get(pickId) as {
    id: number; agent_id: number; amount: number; status: string; entry_price: number | null
  } | undefined

  if (!pick) return NextResponse.json({ error: 'Pick not found' }, { status: 404 })
  if (pick.status !== 'open') return NextResponse.json({ error: 'Pick already resolved', current_status: pick.status }, { status: 409 })

  // Calculate PnL
  let pnl: number
  if (body.pnl !== undefined) {
    pnl = body.pnl
  } else if (body.status === 'won' && body.exit_price != null && pick.entry_price != null) {
    pnl = body.exit_price - pick.entry_price
  } else if (body.status === 'push') {
    pnl = 0
  } else if (body.status === 'cancelled') {
    pnl = 0
  } else {
    pnl = -pick.amount
  }

  const roi = pick.amount > 0 ? (pnl / pick.amount) * 100 : 0
  const returned = body.status === 'cancelled' ? pick.amount : pick.amount + pnl

  db.prepare(`
    UPDATE virtual_picks SET status = ?, exit_price = ?, pnl = ?, roi_pct = ?, close_date = ?
    WHERE id = ?
  `).run(body.status, body.exit_price ?? null, pnl, Math.round(roi * 100) / 100, now, pickId)

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
  `).run(returned, body.status === 'cancelled' ? 0 : pnl, isWin ? 1 : 0, isLoss ? 1 : 0, now, pick.agent_id)

  const updated = db.prepare('SELECT * FROM virtual_picks WHERE id = ?').get(pickId)
  const portfolio = db.prepare('SELECT current_balance, realized_pnl, win_count, loss_count FROM virtual_portfolios WHERE agent_id = ?').get(pick.agent_id)

  return NextResponse.json({ pick: updated, portfolio })
}
