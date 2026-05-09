import { createHash, createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { getDatabase } from '@/lib/db'

export type HubStatusLevel = 'PASS' | 'WARN' | 'FAIL'

export interface HubStatusCheck {
  name: string
  status: HubStatusLevel
  reason: string
}

export interface RemoteHubStatus {
  timestamp: number
  hub_status: HubStatusLevel
  checks: HubStatusCheck[]
  git: {
    status: HubStatusLevel
    branch: string | null
    commit: string | null
    working_tree: {
      status: HubStatusLevel
      summary: string
    }
  }
  validation: {
    status: HubStatusLevel
    summary: string
  }
  heartbeat_summary: {
    status: HubStatusLevel
    total_agents: number
    active_agents: number
    busy_agents: number
    stale_agents: number
    error_agents: number
    recent_heartbeat_count: number
    summary: string
  }
  task_queue_summary: {
    status: HubStatusLevel
    queued_tasks: number
    in_progress_tasks: number
    review_tasks: number
    failed_tasks: number
    summary: string
  }
  recent_signals: {
    status: HubStatusLevel
    warning_count_24h: number
    error_count_24h: number
    summary: string
  }
  runtime: {
    status: HubStatusLevel
    uptime_seconds: number
    last_started_at: string
    summary: string
  }
}

export interface HubStatusSnapshot {
  generated_at: string
  workspace_id: number
  hub_status: HubStatusLevel
  digest_hash: string
  signature_status: 'signed' | 'unsigned'
  signature: string | null
  summary: {
    active_agents: number
    total_agents: number
    queued_tasks: number
    in_progress_tasks: number
    warning_count_24h: number
    error_count_24h: number
  }
  warnings: string[]
}

function makeCheck(name: string, status: HubStatusLevel, reason: string): HubStatusCheck {
  return { name, status, reason }
}

function summarizeOverall(checks: HubStatusCheck[]): HubStatusLevel {
  const coreChecks = checks.filter((check) =>
    ['runtime', 'heartbeat', 'queue', 'signals'].includes(check.name),
  )
  if (coreChecks.some((check) => check.status === 'FAIL')) return 'FAIL'
  if (coreChecks.some((check) => check.status === 'WARN')) return 'WARN'
  return 'PASS'
}

function readPackedRef(gitDir: string, refName: string): string | null {
  const packedRefsPath = path.join(gitDir, 'packed-refs')
  if (!existsSync(packedRefsPath)) return null
  try {
    const content = readFileSync(packedRefsPath, 'utf8')
    for (const line of content.split(/\r?\n/)) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue
      const [sha, ref] = line.trim().split(/\s+/)
      if (ref === refName && sha) return sha
    }
  } catch {
    return null
  }
  return null
}

function resolveGitDir(repoRoot: string): string | null {
  const dotGitPath = path.join(repoRoot, '.git')
  if (!existsSync(dotGitPath)) return null

  try {
    const raw = readFileSync(dotGitPath, 'utf8')
    const match = raw.match(/^gitdir:\s*(.+)\s*$/im)
    if (match?.[1]) {
      return path.resolve(repoRoot, match[1].trim())
    }
  } catch {
    // .git is likely a directory; fall through
  }

  return dotGitPath
}

function collectGitStatus(repoRoot: string): {
  check: HubStatusCheck
  payload: RemoteHubStatus['git']
} {
  const gitDir = resolveGitDir(repoRoot)
  if (!gitDir) {
    return {
      check: makeCheck('git', 'WARN', 'Git metadata unavailable.'),
      payload: {
        status: 'WARN',
        branch: null,
        commit: null,
        working_tree: {
          status: 'WARN',
          summary: 'Unavailable in read-only mode.',
        },
      },
    }
  }

  try {
    const headPath = path.join(gitDir, 'HEAD')
    const head = readFileSync(headPath, 'utf8').trim()
    let branch: string | null = null
    let commit: string | null = null

    if (head.startsWith('ref: ')) {
      const refName = head.slice(5).trim()
      branch = refName.replace(/^refs\/heads\//, '')
      const refPath = path.join(gitDir, ...refName.split('/'))
      if (existsSync(refPath)) {
        commit = readFileSync(refPath, 'utf8').trim()
      } else {
        commit = readPackedRef(gitDir, refName)
      }
    } else if (/^[0-9a-f]{40}$/i.test(head)) {
      commit = head
    }

    const shortCommit = commit ? commit.slice(0, 12) : null
    const status: HubStatusLevel = branch || shortCommit ? 'PASS' : 'WARN'

    return {
      check: makeCheck(
        'git',
        status,
        status === 'PASS'
          ? `Branch ${branch ?? 'detached'} at ${shortCommit ?? 'unknown'}.`
          : 'Git metadata incomplete.',
      ),
      payload: {
        status,
        branch,
        commit: shortCommit,
        working_tree: {
          status: 'WARN',
          summary: 'Working tree summary unavailable without running git status.',
        },
      },
    }
  } catch {
    return {
      check: makeCheck('git', 'WARN', 'Git metadata unavailable.'),
      payload: {
        status: 'WARN',
        branch: null,
        commit: null,
        working_tree: {
          status: 'WARN',
          summary: 'Unavailable in read-only mode.',
        },
      },
    }
  }
}

function collectValidationStatus(): {
  check: HubStatusCheck
  payload: RemoteHubStatus['validation']
} {
  const summary = 'No cached validation summary is available from a safe read-only source.'
  return {
    check: makeCheck('validation', 'WARN', summary),
    payload: {
      status: 'WARN',
      summary,
    },
  }
}

function collectHeartbeatSummary(workspaceId: number, now: number): {
  check: HubStatusCheck
  payload: RemoteHubStatus['heartbeat_summary']
} {
  try {
    const db = getDatabase()
    const row = db.prepare(`
      SELECT
        COUNT(*) as total_agents,
        SUM(CASE WHEN status IN ('idle', 'busy') THEN 1 ELSE 0 END) as active_agents,
        SUM(CASE WHEN status = 'busy' THEN 1 ELSE 0 END) as busy_agents,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_agents,
        SUM(CASE WHEN last_seen IS NOT NULL AND last_seen >= ? THEN 1 ELSE 0 END) as recent_heartbeat_count,
        SUM(CASE WHEN status != 'offline' AND (last_seen IS NULL OR last_seen < ?) THEN 1 ELSE 0 END) as stale_agents
      FROM agents
      WHERE workspace_id = ?
    `).get(now - 300, now - 900, workspaceId) as {
      total_agents?: number
      active_agents?: number
      busy_agents?: number
      error_agents?: number
      recent_heartbeat_count?: number
      stale_agents?: number
    }

    const totalAgents = Number(row?.total_agents || 0)
    const activeAgents = Number(row?.active_agents || 0)
    const busyAgents = Number(row?.busy_agents || 0)
    const errorAgents = Number(row?.error_agents || 0)
    const recentHeartbeatCount = Number(row?.recent_heartbeat_count || 0)
    const staleAgents = Number(row?.stale_agents || 0)

    let status: HubStatusLevel = 'PASS'
    if (totalAgents === 0 || staleAgents > 0 || errorAgents > 0) status = 'WARN'
    if (totalAgents > 0 && staleAgents >= Math.ceil(totalAgents / 2)) status = 'FAIL'

    const summary =
      totalAgents === 0
        ? 'No agents registered in this workspace.'
        : `${activeAgents}/${totalAgents} agents active, ${staleAgents} stale, ${errorAgents} in error.`

    return {
      check: makeCheck('heartbeat', status, summary),
      payload: {
        status,
        total_agents: totalAgents,
        active_agents: activeAgents,
        busy_agents: busyAgents,
        stale_agents: staleAgents,
        error_agents: errorAgents,
        recent_heartbeat_count: recentHeartbeatCount,
        summary,
      },
    }
  } catch {
    const summary = 'Agent heartbeat summary unavailable.'
    return {
      check: makeCheck('heartbeat', 'FAIL', summary),
      payload: {
        status: 'FAIL',
        total_agents: 0,
        active_agents: 0,
        busy_agents: 0,
        stale_agents: 0,
        error_agents: 0,
        recent_heartbeat_count: 0,
        summary,
      },
    }
  }
}

function collectTaskQueueSummary(workspaceId: number): {
  check: HubStatusCheck
  payload: RemoteHubStatus['task_queue_summary']
} {
  try {
    const db = getDatabase()
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('inbox', 'assigned') THEN 1 ELSE 0 END) as queued_tasks,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress_tasks,
        SUM(CASE WHEN status IN ('review', 'quality_review') THEN 1 ELSE 0 END) as review_tasks,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_tasks
      FROM tasks
      WHERE workspace_id = ?
    `).get(workspaceId) as {
      queued_tasks?: number
      in_progress_tasks?: number
      review_tasks?: number
      failed_tasks?: number
    }

    const queuedTasks = Number(row?.queued_tasks || 0)
    const inProgressTasks = Number(row?.in_progress_tasks || 0)
    const reviewTasks = Number(row?.review_tasks || 0)
    const failedTasks = Number(row?.failed_tasks || 0)

    let status: HubStatusLevel = 'PASS'
    if (queuedTasks > 25 || failedTasks > 0) status = 'WARN'
    if (queuedTasks > 100 || failedTasks > 10) status = 'FAIL'

    const summary = `${queuedTasks} queued, ${inProgressTasks} in progress, ${reviewTasks} in review, ${failedTasks} failed.`

    return {
      check: makeCheck('queue', status, summary),
      payload: {
        status,
        queued_tasks: queuedTasks,
        in_progress_tasks: inProgressTasks,
        review_tasks: reviewTasks,
        failed_tasks: failedTasks,
        summary,
      },
    }
  } catch {
    const summary = 'Task queue summary unavailable.'
    return {
      check: makeCheck('queue', 'FAIL', summary),
      payload: {
        status: 'FAIL',
        queued_tasks: 0,
        in_progress_tasks: 0,
        review_tasks: 0,
        failed_tasks: 0,
        summary,
      },
    }
  }
}

function collectRecentSignals(workspaceId: number, now: number): {
  check: HubStatusCheck
  payload: RemoteHubStatus['recent_signals']
} {
  try {
    const db = getDatabase()
    const dayAgo = now - 86400

    const warningCount = Number(
      (
        db.prepare(`
          SELECT COUNT(*) as c
          FROM activities
          WHERE workspace_id = ?
            AND created_at >= ?
            AND (
              LOWER(type) LIKE '%warn%'
              OR LOWER(type) LIKE '%offline%'
              OR LOWER(description) LIKE '%warning%'
              OR LOWER(description) LIKE '%degraded%'
            )
        `).get(workspaceId, dayAgo) as { c?: number }
      )?.c || 0,
    )

    const errorCount = Number(
      (
        db.prepare(`
          SELECT COUNT(*) as c
          FROM activities
          WHERE workspace_id = ?
            AND created_at >= ?
            AND (
              LOWER(type) LIKE '%error%'
              OR LOWER(type) LIKE '%fail%'
              OR LOWER(description) LIKE '%error%'
              OR LOWER(description) LIKE '%failed%'
            )
        `).get(workspaceId, dayAgo) as { c?: number }
      )?.c || 0,
    )

    let status: HubStatusLevel = 'PASS'
    if (warningCount > 0 || errorCount > 0) status = 'WARN'
    if (errorCount > 25) status = 'FAIL'

    const summary = `${warningCount} warnings and ${errorCount} errors in the last 24h.`

    return {
      check: makeCheck('signals', status, summary),
      payload: {
        status,
        warning_count_24h: warningCount,
        error_count_24h: errorCount,
        summary,
      },
    }
  } catch {
    const summary = 'Recent warning and error counts unavailable.'
    return {
      check: makeCheck('signals', 'WARN', summary),
      payload: {
        status: 'WARN',
        warning_count_24h: 0,
        error_count_24h: 0,
        summary,
      },
    }
  }
}

function collectRuntimeSummary(now: number): {
  check: HubStatusCheck
  payload: RemoteHubStatus['runtime']
} {
  const uptimeSeconds = Math.max(0, Math.floor(process.uptime()))
  const lastStartedAt = new Date(now * 1000 - uptimeSeconds * 1000).toISOString()
  const summary = uptimeSeconds > 0 ? `Hub process has been running for ${uptimeSeconds}s.` : 'Hub process just started.'

  return {
    check: makeCheck('runtime', 'PASS', summary),
    payload: {
      status: 'PASS',
      uptime_seconds: uptimeSeconds,
      last_started_at: lastStartedAt,
      summary,
    },
  }
}

export function collectRemoteHubStatus(workspaceId: number, repoRoot: string = process.cwd()): RemoteHubStatus {
  const now = Math.floor(Date.now() / 1000)

  const git = collectGitStatus(repoRoot)
  const validation = collectValidationStatus()
  const heartbeat = collectHeartbeatSummary(workspaceId, now)
  const queue = collectTaskQueueSummary(workspaceId)
  const signals = collectRecentSignals(workspaceId, now)
  const runtime = collectRuntimeSummary(now)

  const checks = [
    git.check,
    validation.check,
    heartbeat.check,
    queue.check,
    signals.check,
    runtime.check,
  ]

  return {
    timestamp: now,
    hub_status: summarizeOverall(checks),
    checks,
    git: git.payload,
    validation: validation.payload,
    heartbeat_summary: heartbeat.payload,
    task_queue_summary: queue.payload,
    recent_signals: signals.payload,
    runtime: runtime.payload,
  }
}

function getHubStatusSigningKey(): string | null {
  const key = (process.env.MC_HUB_STATUS_SIGNING_KEY || '').trim()
  return key || null
}

export function createHubStatusSnapshot(
  status: RemoteHubStatus,
  workspaceId: number,
): HubStatusSnapshot {
  const generatedAt = new Date(status.timestamp * 1000).toISOString()
  const summary = {
    active_agents: status.heartbeat_summary.active_agents,
    total_agents: status.heartbeat_summary.total_agents,
    queued_tasks: status.task_queue_summary.queued_tasks,
    in_progress_tasks: status.task_queue_summary.in_progress_tasks,
    warning_count_24h: status.recent_signals.warning_count_24h,
    error_count_24h: status.recent_signals.error_count_24h,
  }

  const warnings: string[] = []
  if (status.validation.status !== 'PASS') warnings.push(status.validation.summary)
  if (status.git.status !== 'PASS') warnings.push(status.git.working_tree.summary)

  const payload = {
    generated_at: generatedAt,
    workspace_id: workspaceId,
    hub_status: status.hub_status,
    summary,
  }

  const serialized = JSON.stringify(payload)
  const digestHash = createHash('sha256').update(serialized).digest('hex')
  const signingKey = getHubStatusSigningKey()

  if (!signingKey) {
    warnings.push('Hub status snapshot is unsigned because no signing key is configured.')
    return {
      generated_at: generatedAt,
      workspace_id: workspaceId,
      hub_status: status.hub_status,
      digest_hash: digestHash,
      signature_status: 'unsigned',
      signature: null,
      summary,
      warnings,
    }
  }

  return {
    generated_at: generatedAt,
    workspace_id: workspaceId,
    hub_status: status.hub_status,
    digest_hash: digestHash,
    signature_status: 'signed',
    signature: createHmac('sha256', signingKey).update(serialized).digest('hex'),
    summary,
    warnings,
  }
}
