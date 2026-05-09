'use client'

import { useEffect, useState } from 'react'

type HubStatusResponse = {
  timestamp: number
  hub_status: 'PASS' | 'WARN' | 'FAIL'
  git: {
    branch: string | null
    commit: string | null
  }
  validation: {
    summary: string
  }
  heartbeat_summary: {
    active_agents: number
    total_agents: number
  }
  task_queue_summary: {
    queued_tasks: number
    in_progress_tasks: number
  }
  recent_signals: {
    warning_count_24h: number
    error_count_24h: number
  }
}

function toneClass(level: 'PASS' | 'WARN' | 'FAIL') {
  if (level === 'FAIL') return 'text-red-400 border-red-500/30 bg-red-500/10'
  if (level === 'WARN') return 'text-amber-300 border-amber-500/30 bg-amber-500/10'
  return 'text-green-300 border-green-500/30 bg-green-500/10'
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/70 p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-medium text-foreground">{value}</div>
    </div>
  )
}

export default function HubPage() {
  const [status, setStatus] = useState<HubStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    fetch('/api/hub/status')
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'Remote hub status unavailable.' }))
          throw new Error(body.error || 'Remote hub status unavailable.')
        }
        return res.json()
      })
      .then((data) => {
        if (!cancelled) setStatus(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Remote hub status unavailable.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main className="min-h-screen bg-background px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-xl space-y-4">
        <header className="space-y-2">
          <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Mission Control</div>
          <h1 className="text-2xl font-semibold text-foreground">Remote Hub</h1>
          <p className="text-sm text-muted-foreground">
            Read-only mobile status view for checking hub health away from the desk.
          </p>
        </header>

        {loading && (
          <section className="rounded-2xl border border-border/60 bg-card/70 p-4">
            <div className="text-sm text-muted-foreground">Loading remote hub status...</div>
          </section>
        )}

        {!loading && error && (
          <section className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
            <div className="text-sm text-amber-200">{error}</div>
          </section>
        )}

        {!loading && status && (
          <>
            <section className="rounded-2xl border border-border/60 bg-card/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Hub Status</div>
                  <div className="mt-1 text-lg font-semibold text-foreground">{status.hub_status}</div>
                </div>
                <div className={`rounded-full border px-3 py-1 text-xs font-medium ${toneClass(status.hub_status)}`}>
                  {status.hub_status}
                </div>
              </div>
              <div className="mt-3 text-xs text-muted-foreground">
                Updated {new Date(status.timestamp * 1000).toLocaleString()}
              </div>
            </section>

            <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <StatCard label="Branch" value={status.git.branch ?? 'Unavailable'} />
              <StatCard label="Commit" value={status.git.commit ?? 'Unavailable'} />
              <StatCard
                label="Agents"
                value={`${status.heartbeat_summary.active_agents}/${status.heartbeat_summary.total_agents} active`}
              />
              <StatCard
                label="Queue"
                value={`${status.task_queue_summary.queued_tasks} queued / ${status.task_queue_summary.in_progress_tasks} running`}
              />
              <StatCard
                label="Warnings / Errors"
                value={`${status.recent_signals.warning_count_24h} / ${status.recent_signals.error_count_24h}`}
              />
              <StatCard label="Validation" value={status.validation.summary} />
            </section>
          </>
        )}
      </div>
    </main>
  )
}

