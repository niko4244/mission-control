'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useSmartPoll } from '@/lib/use-smart-poll'

interface Pick {
  id: number
  agent_id: number
  agent_name: string
  pick_type: 'stock' | 'sports'
  symbol: string | null
  description: string
  direction: string | null
  amount: number
  entry_price: number | null
  odds: string | null
  confidence: number | null
  rationale: string | null
  status: 'open' | 'won' | 'lost' | 'push' | 'closed' | 'cancelled'
  pnl: number | null
  roi_pct: number | null
  pick_date: number
  close_date: number | null
  extra: string | null
}

interface Portfolio {
  id: number
  agent_id: number
  agent_name: string
  starting_balance: number
  current_balance: number
  realized_pnl: number
  trade_count: number
  win_count: number
  loss_count: number
  portfolio_type: string
  roi_pct: number
  recent_picks: Pick[]
  open_picks: Pick[]
}

const STATUS_PILL: Record<string, string> = {
  open:      'bg-blue-500/15 text-blue-400 border border-blue-500/30',
  won:       'bg-green-500/15 text-green-400 border border-green-500/30',
  lost:      'bg-red-500/15 text-red-400 border border-red-500/30',
  push:      'bg-amber-500/15 text-amber-400 border border-amber-500/30',
  closed:    'bg-muted/20 text-muted-foreground border border-border/30',
  cancelled: 'bg-muted/10 text-muted-foreground/50 border border-border/20',
}

const AGENT_EMOJI: Record<string, string> = { SportsClaw: '🏆', TradingDesk: '📈' }
const AGENT_COLOR: Record<string, string> = {
  SportsClaw:  'from-amber-500/10 to-transparent border-amber-500/20',
  TradingDesk: 'from-emerald-500/10 to-transparent border-emerald-500/20',
}

function formatDate(unix: number) {
  return new Date(unix * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatCurrency(n: number) {
  return '$' + Math.abs(n).toFixed(2)
}

// ── Mini sparkline from pick history ─────────────────────────────────────────
function BalanceSparkline({ picks, starting }: { picks: Pick[]; starting: number }) {
  const resolved = [...picks].filter(p => p.status !== 'open' && p.status !== 'cancelled').sort((a, b) => a.pick_date - b.pick_date)
  if (resolved.length === 0) return (
    <div className="h-10 flex items-center justify-center text-2xs text-muted-foreground/40 italic">No closed picks yet</div>
  )

  let running = starting
  const points = [{ x: 0, y: starting }]
  resolved.forEach((p, i) => {
    running += p.pnl ?? 0
    points.push({ x: i + 1, y: running })
  })

  const xs = points.map(p => p.x)
  const ys = points.map(p => p.y)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys, starting + 0.01)
  const w = 200; const h = 40
  const scaleX = (x: number) => (x / (points.length - 1)) * w
  const scaleY = (y: number) => h - ((y - minY) / (maxY - minY)) * (h - 4) - 2
  const polyline = points.map(p => `${scaleX(p.x)},${scaleY(p.y)}`).join(' ')
  const area = `0,${h} ${polyline} ${w},${h}`
  const isUp = (points[points.length - 1]?.y ?? starting) >= starting
  const color = isUp ? '#22c55e' : '#ef4444'

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-10" preserveAspectRatio="none" suppressHydrationWarning>
      <polygon points={area} fill={color} opacity="0.12" suppressHydrationWarning />
      <polyline points={polyline} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" suppressHydrationWarning />
    </svg>
  )
}

// ── Portfolio header card ─────────────────────────────────────────────────────
function PortfolioCard({ portfolio, onTriggerPick, triggering }: {
  portfolio: Portfolio
  onTriggerPick: (name: string) => void
  triggering: boolean
}) {
  const emoji = AGENT_EMOJI[portfolio.agent_name] ?? '🤖'
  const colorClass = AGENT_COLOR[portfolio.agent_name] ?? 'from-muted/10 to-transparent border-border/30'
  const roi = portfolio.roi_pct ?? ((portfolio.current_balance - portfolio.starting_balance) / portfolio.starting_balance * 100)
  const roiColor = roi > 0 ? 'text-green-400' : roi < 0 ? 'text-red-400' : 'text-muted-foreground'
  const winRate = (portfolio.win_count + portfolio.loss_count) > 0
    ? Math.round(portfolio.win_count / (portfolio.win_count + portfolio.loss_count) * 100)
    : 0
  const pnlColor = portfolio.realized_pnl >= 0 ? 'text-green-400' : 'text-red-400'

  return (
    <div className={`rounded-xl border bg-gradient-to-br ${colorClass} p-4 flex flex-col gap-3`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-2xl">{emoji}</span>
          <div>
            <div className="text-sm font-bold text-foreground">{portfolio.agent_name}</div>
            <div className="text-2xs text-muted-foreground/60 capitalize">{portfolio.portfolio_type} portfolio</div>
          </div>
        </div>
        <button
          type="button"
          disabled={triggering}
          onClick={() => onTriggerPick(portfolio.agent_name)}
          className="text-2xs px-2.5 py-1 rounded border border-border/50 bg-card/50 hover:bg-card text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {triggering ? '⏳ Picking...' : '⚡ Pick Now'}
        </button>
      </div>

      {/* Balance + ROI */}
      <div className="grid grid-cols-4 gap-3">
        <div className="col-span-2">
          <div className="text-2xs text-muted-foreground/60 mb-0.5">Balance</div>
          <div className="text-xl font-mono font-bold text-foreground" suppressHydrationWarning>
            ${portfolio.current_balance.toFixed(2)}
          </div>
          <div className="text-2xs text-muted-foreground/50">started ${portfolio.starting_balance.toFixed(0)}</div>
        </div>
        <div>
          <div className="text-2xs text-muted-foreground/60 mb-0.5">ROI</div>
          <div className={`text-lg font-mono font-bold ${roiColor}`} suppressHydrationWarning>
            {roi >= 0 ? '+' : ''}{roi.toFixed(1)}%
          </div>
        </div>
        <div>
          <div className="text-2xs text-muted-foreground/60 mb-0.5">Win Rate</div>
          <div className="text-lg font-mono font-bold text-foreground">{winRate}%</div>
          <div className="text-2xs text-muted-foreground/50">{portfolio.win_count}W {portfolio.loss_count}L</div>
        </div>
      </div>

      {/* Sparkline */}
      <BalanceSparkline picks={portfolio.recent_picks} starting={portfolio.starting_balance} />

      {/* Stats row */}
      <div className="flex gap-4 text-2xs border-t border-border/20 pt-2">
        <span className="text-muted-foreground/60">{portfolio.trade_count} picks total</span>
        <span className="text-blue-400">{portfolio.open_picks.length} open</span>
        <span className={pnlColor}>
          P&L: {portfolio.realized_pnl >= 0 ? '+' : ''}${portfolio.realized_pnl.toFixed(2)}
        </span>
      </div>
    </div>
  )
}

// ── Single pick row ────────────────────────────────────────────────────────────
function PickCard({ pick, onResolve }: { pick: Pick; onResolve: (id: number, status: string, pnl?: number) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [pnlInput, setPnlInput] = useState('')
  const extra = pick.extra ? (() => { try { return JSON.parse(pick.extra!); } catch { return {}; } })() : {}

  const handleResolve = async (status: string) => {
    setResolving(true)
    const pnl = pnlInput ? parseFloat(pnlInput) : undefined
    await onResolve(pick.id, status, pnl)
    setResolving(false)
    setPnlInput('')
  }

  return (
    <div className="rounded-lg border border-border/40 bg-card/30 overflow-hidden">
      {/* Header row */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-card/50 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="text-sm">{AGENT_EMOJI[pick.agent_name] ?? '🤖'}</span>

        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-foreground/90 truncate">{pick.description}</div>
          <div className="flex items-center gap-2 mt-0.5">
            {pick.symbol && <span className="text-2xs font-mono text-foreground/60 bg-muted/20 px-1.5 py-0.5 rounded">{pick.symbol}</span>}
            {pick.odds && <span className="text-2xs text-muted-foreground/70">{pick.odds}</span>}
            {pick.confidence != null && (
              <span className="text-2xs text-muted-foreground/50">{Math.round(pick.confidence * 100)}% conf</span>
            )}
            <span className="text-2xs text-muted-foreground/40" suppressHydrationWarning>{formatDate(pick.pick_date)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs font-mono text-foreground/70">${pick.amount.toFixed(0)}</span>
          {pick.pnl != null && (
            <span className={`text-xs font-mono font-semibold ${pick.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {pick.pnl >= 0 ? '+' : ''}{formatCurrency(pick.pnl)}
            </span>
          )}
          <span className={`text-2xs px-2 py-0.5 rounded-full font-medium ${STATUS_PILL[pick.status] ?? STATUS_PILL.closed}`}>
            {pick.status.toUpperCase()}
          </span>
          <span className="text-muted-foreground/30 text-xs">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-border/20 space-y-3">
          {pick.rationale && (
            <div className="mt-3">
              <div className="text-2xs text-muted-foreground/50 uppercase tracking-wider mb-1">Rationale</div>
              <p className="text-xs text-foreground/80 leading-relaxed bg-muted/10 rounded p-3 border border-border/20">
                {pick.rationale}
              </p>
            </div>
          )}

          {Object.keys(extra).length > 0 && (
            <div>
              <div className="text-2xs text-muted-foreground/50 uppercase tracking-wider mb-1">Details</div>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(extra).map(([k, v]) => (
                  <div key={k} className="text-2xs bg-muted/10 rounded p-2 border border-border/20">
                    <span className="text-muted-foreground/50">{k.replace(/_/g, ' ')}: </span>
                    <span className="text-foreground/70">{String(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {pick.status === 'open' && (
            <div className="flex items-center gap-2 flex-wrap pt-1">
              <div className="text-2xs text-muted-foreground/50">Resolve:</div>
              <input
                type="number"
                placeholder="P&L ($)"
                value={pnlInput}
                onChange={e => setPnlInput(e.target.value)}
                className="text-2xs w-24 px-2 py-1 rounded border border-border/40 bg-card/50 text-foreground placeholder:text-muted-foreground/40"
              />
              {['won', 'lost', 'push', 'cancelled'].map(s => (
                <button
                  key={s}
                  type="button"
                  disabled={resolving}
                  onClick={() => handleResolve(s)}
                  className={`text-2xs px-2 py-1 rounded border transition-colors disabled:opacity-50 ${
                    s === 'won' ? 'border-green-500/40 text-green-400 hover:bg-green-500/10' :
                    s === 'lost' ? 'border-red-500/40 text-red-400 hover:bg-red-500/10' :
                    s === 'push' ? 'border-amber-500/40 text-amber-400 hover:bg-amber-500/10' :
                    'border-border/30 text-muted-foreground hover:bg-muted/20'
                  }`}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main Panel ─────────────────────────────────────────────────────────────────
export function AgentPortfolioPanel() {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([])
  const [filter, setFilter] = useState<'all' | 'open' | 'closed'>('all')
  const [agentFilter, setAgentFilter] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [triggering, setTriggering] = useState<string | null>(null)
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/virtual-portfolio')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as Portfolio[]
      setPortfolios(data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])
  useSmartPoll(fetchData, 30_000)

  const handleResolve = useCallback(async (pickId: number, status: string, pnl?: number) => {
    await fetch(`/api/virtual-portfolio/picks/${pickId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, ...(pnl !== undefined ? { pnl } : {}) }),
    })
    fetchData()
  }, [fetchData])

  const handleTriggerPick = useCallback(async (agentName: string) => {
    setTriggering(agentName)
    setTriggerMsg(null)
    try {
      const res = await fetch('/api/virtual-portfolio/trigger-pick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: agentName }),
      })
      const data = await res.json() as { ok: boolean; message?: string; error?: string }
      setTriggerMsg(data.message || data.error || 'Done')
      if (data.ok) setTimeout(fetchData, 2000)
    } catch (e) {
      setTriggerMsg(e instanceof Error ? e.message : 'Failed')
    } finally {
      setTriggering(null)
      setTimeout(() => setTriggerMsg(null), 8000)
    }
  }, [fetchData])

  // Collect all picks across portfolios
  const allPicks = portfolios.flatMap(p =>
    p.recent_picks.map(pick => ({ ...pick, agent_name: p.agent_name }))
  ).sort((a, b) => b.pick_date - a.pick_date)

  const filteredPicks = allPicks.filter(pick => {
    if (agentFilter !== 'all' && pick.agent_name !== agentFilter) return false
    if (filter === 'open') return pick.status === 'open'
    if (filter === 'closed') return pick.status !== 'open'
    return true
  })

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        Loading portfolio data…
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-2">
        <p className="text-red-400 text-sm">{error}</p>
        <button type="button" onClick={fetchData} className="text-2xs px-3 py-1 rounded border border-border/40 text-muted-foreground hover:text-foreground">
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 p-4 max-w-5xl mx-auto">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-foreground">Agent Portfolios</h1>
          <p className="text-2xs text-muted-foreground/60 mt-0.5">
            Virtual $100 starting balance · picks powered by deepseek-r1 via Ollama
          </p>
        </div>
        {triggerMsg && (
          <div className="text-2xs px-3 py-1.5 rounded border border-border/40 bg-card/60 text-muted-foreground max-w-xs truncate">
            {triggerMsg}
          </div>
        )}
      </div>

      {portfolios.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground/60 text-sm">
          No portfolios seeded yet. The daemon will create picks at scheduled times.
        </div>
      ) : (
        <>
          {/* Portfolio cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {portfolios.map(p => (
              <PortfolioCard
                key={p.agent_id}
                portfolio={p}
                onTriggerPick={handleTriggerPick}
                triggering={triggering === p.agent_name}
              />
            ))}
          </div>

          {/* Pick history */}
          <div>
            {/* Filters */}
            <div className="flex items-center gap-3 mb-3 flex-wrap">
              <span className="text-xs font-semibold text-foreground/70">Picks</span>
              <div className="flex gap-1">
                {(['all', 'open', 'closed'] as const).map(f => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setFilter(f)}
                    className={`text-2xs px-2.5 py-1 rounded border transition-colors capitalize ${
                      filter === f
                        ? 'bg-accent text-foreground border-border'
                        : 'text-muted-foreground border-border/30 hover:text-foreground'
                    }`}
                  >
                    {f} {f !== 'all' && `(${allPicks.filter(p => f === 'open' ? p.status === 'open' : p.status !== 'open').length})`}
                  </button>
                ))}
              </div>
              <div className="flex gap-1">
                {(['all', ...portfolios.map(p => p.agent_name)]).map(a => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAgentFilter(a)}
                    className={`text-2xs px-2.5 py-1 rounded border transition-colors ${
                      agentFilter === a
                        ? 'bg-accent text-foreground border-border'
                        : 'text-muted-foreground border-border/30 hover:text-foreground'
                    }`}
                  >
                    {a === 'all' ? 'All agents' : `${AGENT_EMOJI[a] ?? ''} ${a}`}
                  </button>
                ))}
              </div>
              <span className="text-2xs text-muted-foreground/40 ml-auto">
                {filteredPicks.length} picks · click to expand rationale
              </span>
            </div>

            {/* Pick list */}
            <div className="flex flex-col gap-2">
              {filteredPicks.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground/50 text-sm">
                  No picks match this filter yet.
                </div>
              ) : (
                filteredPicks.map(pick => (
                  <PickCard key={pick.id} pick={pick} onResolve={handleResolve} />
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
