'use client'

import { useState, useCallback, useEffect } from 'react'
import { useSmartPoll } from '@/lib/use-smart-poll'
import type { DashboardData } from '../widget-primitives'

interface BotRegistryData {
  agent: string
  status: 'PASS' | 'WARN' | 'FAIL'
  timestamp: string
  bot_registry: {
    implemented_count: number
    planned_count: number
    implemented: string[]
    planned: string[]
    hierarchy_warnings: string[]
    blocking_conditions: string[]
  }
  release_governor: {
    status: string
    branch: string
    working_tree_clean: boolean
    warnings: string[]
    blockers: string[]
  }
  summary: {
    observe_only: boolean
    governance_healthy: boolean
    pending_bot_count: number
  }
  error?: { message: string }
}

const STATUS_DOT: Record<string, string> = {
  PASS: 'bg-green-500',
  WARN: 'bg-amber-500',
  FAIL: 'bg-red-500',
}

const STATUS_TEXT: Record<string, string> = {
  PASS: 'text-green-400',
  WARN: 'text-amber-400',
  FAIL: 'text-red-400',
}

export function BotRegistryWidget({ data }: { data: DashboardData }) {
  const { navigateToPanel } = data
  const [state, setState] = useState<BotRegistryData | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch('/api/governance/status')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as BotRegistryData
      setState(json)
      setFetchError(null)
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : 'Failed to fetch')
    }
  }, [])

  useEffect(() => { fetchState() }, [fetchState])
  useSmartPoll(fetchState, 60000)

  if (fetchError) {
    return (
      <div className="rounded-xl border border-border bg-card/80 px-4 py-2.5 flex items-center justify-between">
        <span className="text-2xs font-semibold text-foreground/80">Bot Registry</span>
        <span className="text-2xs text-red-400">{fetchError}</span>
      </div>
    )
  }

  if (!state) {
    return (
      <div className="rounded-xl border border-border bg-card/80 px-4 py-2.5">
        <span className="text-2xs text-muted-foreground">Loading bot registry…</span>
      </div>
    )
  }

  const reg = state.bot_registry
  const rel = state.release_governor
  const dotClass = STATUS_DOT[state.status] ?? 'bg-red-500'
  const statusClass = STATUS_TEXT[state.status] ?? 'text-red-400'
  const relDotClass = STATUS_DOT[rel.status] ?? 'bg-red-500'
  const tsStr = state.timestamp ? new Date(state.timestamp).toLocaleTimeString() : '—'

  return (
    <div className="rounded-xl border border-border bg-card/80 text-2xs text-muted-foreground">
      <div className="px-4 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="text-xs font-semibold text-foreground/80">Bot Registry</span>

        <span className="inline-flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
          <span className={`font-mono-tight font-semibold ${statusClass}`}>{state.status}</span>
        </span>

        <span>
          <span className="text-green-400 font-mono-tight">{reg.implemented_count}</span>
          {' '}implemented
        </span>

        <span>
          <span className="text-amber-400 font-mono-tight">{reg.planned_count}</span>
          {' '}pending
        </span>

        {reg.hierarchy_warnings.length > 0 && (
          <span className="text-amber-400">
            {reg.hierarchy_warnings.length} hierarchy warning{reg.hierarchy_warnings.length !== 1 ? 's' : ''}
          </span>
        )}

        <span className="inline-flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${relDotClass}`} />
          <span className="font-mono-tight">{rel.branch || '—'}</span>
          {rel.working_tree_clean
            ? <span className="text-green-400">clean</span>
            : <span className="text-amber-400">dirty</span>}
        </span>

        <span className="text-muted-foreground/50 font-mono-tight">{tsStr}</span>

        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="text-2xs text-muted-foreground/60 hover:text-foreground border border-border/50 rounded px-2 py-0.5 transition-colors"
          aria-label="Toggle bot list"
        >
          {expanded ? 'Hide' : 'Show'} bots
        </button>

        <button
          type="button"
          onClick={() => navigateToPanel('mc-status')}
          className="ml-auto text-2xs text-muted-foreground/60 hover:text-foreground border border-border/50 rounded px-2 py-0.5 transition-colors"
        >
          Details →
        </button>
      </div>

      {expanded && (
        <div className="border-t border-border/50 px-4 py-2.5 grid grid-cols-2 gap-x-8 gap-y-0.5">
          <div>
            <div className="text-2xs font-semibold text-green-400 mb-1">Implemented ({reg.implemented_count})</div>
            {reg.implemented.map((id) => (
              <div key={id} className="font-mono-tight text-foreground/70">{id}</div>
            ))}
          </div>
          <div>
            <div className="text-2xs font-semibold text-amber-400 mb-1">Pending ({reg.planned_count})</div>
            {reg.planned.slice(0, 10).map((id) => (
              <div key={id} className="font-mono-tight text-muted-foreground/60">{id}</div>
            ))}
            {reg.planned.length > 10 && (
              <div className="text-muted-foreground/40">+{reg.planned.length - 10} more</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
