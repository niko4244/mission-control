import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { requireWorkspaceId } from '@/lib/enforcement/workspace-scope'
import { collectRemoteHubStatus } from '@/lib/hub-status'
import { checkHubStatusRateLimit } from '@/lib/hub-status-rate-limit'
import { logger } from '@/lib/logger'

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const wsResult = requireWorkspaceId(auth.user)
  if (!('workspaceId' in wsResult)) return wsResult.response

  const rateLimited = checkHubStatusRateLimit(request, auth.user, wsResult.workspaceId)
  if (rateLimited) return rateLimited

  try {
    return NextResponse.json(collectRemoteHubStatus(wsResult.workspaceId))
  } catch (error) {
    logger.error({ err: error }, 'GET /api/hub/status error')
    return NextResponse.json(
      {
        timestamp: Math.floor(Date.now() / 1000),
        hub_status: 'FAIL',
        checks: [{ name: 'route', status: 'FAIL', reason: 'Remote hub status is temporarily unavailable.' }],
        git: {
          status: 'WARN',
          branch: null,
          commit: null,
          working_tree: {
            status: 'WARN',
            summary: 'Unavailable in read-only mode.',
          },
        },
        validation: {
          status: 'WARN',
          summary: 'No cached validation summary is available from a safe read-only source.',
        },
        heartbeat_summary: {
          status: 'FAIL',
          total_agents: 0,
          active_agents: 0,
          busy_agents: 0,
          stale_agents: 0,
          error_agents: 0,
          recent_heartbeat_count: 0,
          summary: 'Agent heartbeat summary unavailable.',
        },
        task_queue_summary: {
          status: 'FAIL',
          queued_tasks: 0,
          in_progress_tasks: 0,
          review_tasks: 0,
          failed_tasks: 0,
          summary: 'Task queue summary unavailable.',
        },
        recent_signals: {
          status: 'WARN',
          warning_count_24h: 0,
          error_count_24h: 0,
          summary: 'Recent warning and error counts unavailable.',
        },
        runtime: {
          status: 'WARN',
          uptime_seconds: 0,
          last_started_at: new Date().toISOString(),
          summary: 'Runtime summary unavailable.',
        },
      },
      { status: 200 },
    )
  }
}
