import { describe, expect, it, vi } from 'vitest'
import { createHubStatusSnapshot, type RemoteHubStatus } from '@/lib/hub-status'

function makeStatus(overrides?: Partial<RemoteHubStatus>): RemoteHubStatus {
  return {
    timestamp: 1_700_000_000,
    hub_status: 'PASS',
    checks: [],
    git: {
      status: 'PASS',
      branch: 'main',
      commit: 'abc123def456',
      working_tree: { status: 'WARN', summary: 'Working tree summary unavailable without running git status.' },
    },
    validation: {
      status: 'WARN',
      summary: 'No cached validation summary is available from a safe read-only source.',
    },
    heartbeat_summary: {
      status: 'PASS',
      total_agents: 4,
      active_agents: 3,
      busy_agents: 1,
      stale_agents: 0,
      error_agents: 0,
      recent_heartbeat_count: 3,
      summary: '3/4 agents active.',
    },
    task_queue_summary: {
      status: 'PASS',
      queued_tasks: 2,
      in_progress_tasks: 1,
      review_tasks: 0,
      failed_tasks: 0,
      summary: '2 queued, 1 in progress.',
    },
    recent_signals: {
      status: 'WARN',
      warning_count_24h: 1,
      error_count_24h: 0,
      summary: '1 warnings and 0 errors in the last 24h.',
    },
    runtime: {
      status: 'PASS',
      uptime_seconds: 60,
      last_started_at: '2026-05-08T18:00:00.000Z',
      summary: 'Hub process has been running for 60s.',
    },
    ...overrides,
  }
}

describe('createHubStatusSnapshot', () => {
  it('excludes secret-like keys from the sanitized digest', () => {
    const snapshot = createHubStatusSnapshot(makeStatus(), 7)
    const encoded = JSON.stringify(snapshot).toLowerCase()

    expect(encoded).not.toContain('api_key')
    expect(encoded).not.toContain('token')
    expect(encoded).not.toContain('secret')
    expect(encoded).not.toContain('cookie')
  })

  it('changes digest hash when status changes', () => {
    const a = createHubStatusSnapshot(makeStatus(), 7)
    const b = createHubStatusSnapshot(
      makeStatus({
        hub_status: 'WARN',
        task_queue_summary: {
          ...makeStatus().task_queue_summary,
          queued_tasks: 9,
          summary: '9 queued, 1 in progress.',
        },
      }),
      7,
    )

    expect(a.digest_hash).not.toBe(b.digest_hash)
  })

  it('degrades to unsigned snapshot when no signing key is configured', () => {
    const originalKey = process.env.MC_HUB_STATUS_SIGNING_KEY
    delete process.env.MC_HUB_STATUS_SIGNING_KEY

    const snapshot = createHubStatusSnapshot(makeStatus(), 7)

    expect(snapshot.signature_status).toBe('unsigned')
    expect(snapshot.signature).toBeNull()
    expect(snapshot.warnings.some((warning) => warning.toLowerCase().includes('unsigned'))).toBe(true)

    if (originalKey) process.env.MC_HUB_STATUS_SIGNING_KEY = originalKey
  })
})

