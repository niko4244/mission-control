'use client'

import { HealthRow, formatUptime, type DashboardData } from '../widget-primitives'

function toneFor(level: 'PASS' | 'WARN' | 'FAIL'): 'good' | 'warn' | 'bad' {
  if (level === 'FAIL') return 'bad'
  if (level === 'WARN') return 'warn'
  return 'good'
}

export function RemoteHubStatusWidget({ data }: { data: DashboardData }) {
  const { hubStatus, isHubLoading } = data

  if (isHubLoading && !hubStatus) {
    return (
      <div className="panel">
        <div className="panel-header"><h3 className="text-sm font-semibold">Remote Hub Status</h3></div>
        <div className="panel-body">
          <span className="text-2xs text-muted-foreground">Loading remote hub status...</span>
        </div>
      </div>
    )
  }

  if (!hubStatus) {
    return (
      <div className="panel">
        <div className="panel-header"><h3 className="text-sm font-semibold">Remote Hub Status</h3></div>
        <div className="panel-body space-y-3">
          <HealthRow label="Remote Hub" value="Unavailable" status="warn" />
          <p className="text-2xs text-muted-foreground">
            Status could not be loaded from the read-only hub endpoint.
          </p>
        </div>
      </div>
    )
  }

  const uptimeMs = hubStatus.runtime.uptime_seconds * 1000
  const branchLabel = hubStatus.git.branch ?? 'Unavailable'
  const commitLabel = hubStatus.git.commit ?? 'Unavailable'

  return (
    <div className="panel">
      <div className="panel-header"><h3 className="text-sm font-semibold">Remote Hub Status</h3></div>
      <div className="panel-body space-y-3">
        <HealthRow label="Hub" value={hubStatus.hub_status} status={toneFor(hubStatus.hub_status)} />
        <HealthRow label="Git Branch" value={branchLabel} status={toneFor(hubStatus.git.status)} />
        <HealthRow label="Git Commit" value={commitLabel} status={toneFor(hubStatus.git.status)} />
        <HealthRow
          label="Working Tree"
          value={hubStatus.git.working_tree.summary}
          status={toneFor(hubStatus.git.working_tree.status)}
        />
        <HealthRow
          label="Validation"
          value={hubStatus.validation.summary}
          status={toneFor(hubStatus.validation.status)}
        />
        <HealthRow
          label="Agents"
          value={`${hubStatus.heartbeat_summary.active_agents}/${hubStatus.heartbeat_summary.total_agents} active`}
          status={toneFor(hubStatus.heartbeat_summary.status)}
        />
        <HealthRow
          label="Queue"
          value={`${hubStatus.task_queue_summary.queued_tasks} queued`}
          status={toneFor(hubStatus.task_queue_summary.status)}
        />
        <HealthRow
          label="Warnings / Errors"
          value={`${hubStatus.recent_signals.warning_count_24h} / ${hubStatus.recent_signals.error_count_24h}`}
          status={toneFor(hubStatus.recent_signals.status)}
        />
        <HealthRow
          label="Uptime"
          value={formatUptime(uptimeMs)}
          status={toneFor(hubStatus.runtime.status)}
        />
        <p className="text-2xs text-muted-foreground">
          Last started {new Date(hubStatus.runtime.last_started_at).toLocaleString()}.
        </p>
      </div>
    </div>
  )
}
