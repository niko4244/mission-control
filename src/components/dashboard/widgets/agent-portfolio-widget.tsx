'use client'

import { useState, useCallback, useEffect } from 'react'
import { useSmartPoll } from '@/lib/use-smart-poll'
import type { DashboardData } from '../widget-primitives'

interface Pick {
  id: number
  pick_type: 'stock' | 'sports'
  symbol: string | null
  description: string
  direction: string | null
  amount: number
  odds: string | null
  confidence: number | null
  rationale: string | null
  status: 'open' | 'won' | 'lost' | 'push' | 'closed' | 'cancelled'
  pnl: number | null
  roi_pct: number | null
  pick_date: number
  close_date: number | null
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

const STATUS_COLORS: Record<string, string> = {
  won: 'text-green-400',
  lost: 'text-red-400',
  push: 'text-amber-400',
  open: 'text-blue-400',
  closed: 'text-muted-foreground',
  cancelled: 'text-muted-foreground/50',
}

const STATUS_BG: Record<string, string> = {
  won: 'bg-green-500/10 border-green-500/20',
  lost: 'bg-red-500/10 border-red-500/20',
  push: 'bg-amber-500/10 border-amber-500/20',
  open: 'bg-blue-500/10 border-blue-500/20',
  closed: 'bg-muted/20 border-border/30',
  cancelled: 'bg-muted/10 border-border/20',
}

const AGENT_EMOJI: Record<string, string> = {
  SportsClaw: '🏆',
  TradingDesk: '📈',
}

function BalanceBar({ current, starting }: { current: number; starting: number }) {
  const pct = Math.min(Math.max((current / (starting * 2)) * 100, 0), 100)
  const color = current >= starting ? 'bg-green-500' : 'bg-red-500'
  return (
    <div className="w-full h-1 bg-muted/30 rounded-full overflow-hidden">
      <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

function PickRow({ pick }: { pick: Pick }) {
  const [expanded, setExpanded] = useState(false)
  const date = new Date(pick.pick_date * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const statusColor = STATUS_COLORS[pick.status] ?? 'text-muted-foreground'

  return (
    <div
      className={`rounded border px-2.5 py-1.5 cursor-pointer transition-colors hover:bg-card/60 ${STATUS_BG[pick.status] ?? 'bg-muted/10 border-border/20'}`}
      onClick={() => setExpanded((e) => !e)}
    >
      <div className="flex items-center gap-2 text-2xs">
        <span className="text-muted-foreground/60 font-mono-tight w-12 shrink-0" suppressHydrationWarning>{date}</span>
        {pick.symbol && (
          <span className="font-mono-tight font-semibold text-foreground/80 shrink-0">{pick.symbol}</span>
        )}
        <span className="text-foreground/70 truncate flex-1">{pick.description}</span>
        {pick.odds && <span className="font-mono-tight text-muted-foreground shrink-0">{pick.odds}</span>}
        <span className="font-mono-tight text-foreground/60 shrink-0">${pick.amount.toFixed(0)}</span>
        <span className={`font-mono-tight font-semibold shrink-0 ${statusColor}`}>
          {pick.status === 'open' ? 'OPEN'
            : pick.pnl != null
              ? `${pick.pnl >= 0 ? '+' : ''}$${pick.pnl.toFixed(2)}`
              : pick.status.toUpperCase()}
        </span>
      </div>
      {expanded && pick.rationale && (
        <div className="mt-1.5 text-2xs text-muted-foreground/70 pl-14 leading-relaxed">
          {pick.rationale}
        </div>
      )}
    </div>
  )
}

function PortfolioCard({ portfolio, navigateToPanel }: { portfolio: Portfolio; navigateToPanel: (id: string) => void }) {
  const [tab, setTab] = useState<'open' | 'recent'>('open')
  const emoji = AGENT_EMOJI[portfolio.agent_name] ?? '🤖'
  const roi = portfolio.roi_pct ?? 0
  const roiColor = roi > 0 ? 'text-green-400' : roi < 0 ? 'text-red-400' : 'text-muted-foreground'
  const winRate = portfolio.trade_count > 0
    ? Math.round((portfolio.win_count / (portfolio.win_count + portfolio.loss_count || 1)) * 100)
    : 0
  const picks = tab === 'open' ? portfolio.open_picks : portfolio.recent_picks

  return (
    <div className="flex-1 min-w-0 rounded-xl border border-border bg-card/60 p-3 flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-base">{emoji}</span>
          <span className="text-xs font-semibold text-foreground/90">{portfolio.agent_name}</span>
          <span className="text-2xs text-muted-foreground/50 capitalize">{portfolio.portfolio_type}</span>
        </div>
        <button
          type="button"
          onClick={() => navigateToPanel('agents')}
          className="text-2xs text-muted-foreground/50 hover:text-foreground border border-border/40 rounded px-1.5 py-0.5 transition-colors"
        >
          Agent →
        </button>
      </div>

      {/* Balance + ROI */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-lg font-mono-tight font-bold text-foreground">
            ${portfolio.current_balance.toFixed(2)}
          </div>
          <div className="text-2xs text-muted-foreground/60">
            started ${portfolio.starting_balance.toFixed(0)}
          </div>
        </div>
        <div className="text-right">
          <div className={`text-sm font-mono-tight font-bold ${roiColor}`}>
            {roi >= 0 ? '+' : ''}{roi.toFixed(1)}%
          </div>
          <div className="text-2xs text-muted-foreground/60">ROI</div>
        </div>
        <div className="text-right">
          <div className="text-sm font-mono-tight font-bold text-foreground/80">{winRate}%</div>
          <div className="text-2xs text-muted-foreground/60">win rate</div>
        </div>
        <div className="text-right">
          <div className="text-sm font-mono-tight font-bold text-foreground/80">{portfolio.trade_count}</div>
          <div className="text-2xs text-muted-foreground/60">picks</div>
        </div>
      </div>

      <BalanceBar current={portfolio.current_balance} starting={portfolio.starting_balance} />

      {/* W/L record */}
      <div className="flex gap-3 text-2xs">
        <span className="text-green-400 font-mono-tight">{portfolio.win_count}W</span>
        <span className="text-red-400 font-mono-tight">{portfolio.loss_count}L</span>
        <span className="text-muted-foreground/60">
          P&amp;L{' '}
          <span className={portfolio.realized_pnl >= 0 ? 'text-green-400' : 'text-red-400'}>
            {portfolio.realized_pnl >= 0 ? '+' : ''}${portfolio.realized_pnl.toFixed(2)}
          </span>
        </span>
        {portfolio.open_picks.length > 0 && (
          <span className="text-blue-400">{portfolio.open_picks.length} open</span>
        )}
      </div>

      {/* Picks tabs */}
      <div className="flex gap-1 border-b border-border/30 pb-1">
        {(['open', 'recent'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`text-2xs px-2 py-0.5 rounded transition-colors ${
              tab === t ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t === 'open' ? `Open (${portfolio.open_picks.length})` : 'Recent'}
          </button>
        ))}
      </div>

      {/* Picks list */}
      <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
        {picks.length === 0 ? (
          <div className="text-2xs text-muted-foreground/40 italic py-2 text-center">
            No {tab} picks yet
          </div>
        ) : (
          picks.map((pick) => <PickRow key={pick.id} pick={pick} />)
        )}
      </div>
    </div>
  )
}

export function AgentPortfolioWidget({ data }: { data: DashboardData }) {
  const { navigateToPanel } = data
  const [portfolios, setPortfolios] = useState<Portfolio[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const fetch_ = useCallback(async () => {
    try {
      const res = await fetch('/api/virtual-portfolio')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data_ = await res.json() as Portfolio[]
      setPortfolios(data_)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetch_() }, [fetch_])
  useSmartPoll(fetch_, 60000)

  if (loading) {
    return (
      <div className="rounded-xl border border-border bg-card/80 px-4 py-3">
        <span className="text-2xs text-muted-foreground">Loading portfolios…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-xl border border-border bg-card/80 px-4 py-3 flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground/80">Agent Portfolios</span>
        <span className="text-2xs text-red-400">{error}</span>
      </div>
    )
  }

  if (portfolios.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card/80 px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-foreground/80">Agent Portfolios</span>
        </div>
        <p className="text-2xs text-muted-foreground/60">
          No portfolios configured yet. SportsClaw and TradingDesk portfolios will appear here once seeded.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-border bg-card/80 p-3">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-foreground/80">Agent Portfolios</span>
        <span className="text-2xs text-muted-foreground/50">$100 start · click picks for rationale</span>
      </div>
      <div className="flex gap-3 flex-col md:flex-row">
        {portfolios.map((p) => (
          <PortfolioCard key={p.agent_id} portfolio={p} navigateToPanel={navigateToPanel} />
        ))}
      </div>
    </div>
  )
}
