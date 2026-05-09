import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { requireWorkspaceId } from '@/lib/enforcement/workspace-scope'
import { collectRemoteHubStatus, createHubStatusSnapshot } from '@/lib/hub-status'
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
    const status = collectRemoteHubStatus(wsResult.workspaceId)
    return NextResponse.json(createHubStatusSnapshot(status, wsResult.workspaceId))
  } catch (error) {
    logger.error({ err: error }, 'GET /api/hub/status/snapshot error')
    return NextResponse.json(
      {
        generated_at: new Date().toISOString(),
        workspace_id: wsResult.workspaceId,
        hub_status: 'FAIL',
        digest_hash: null,
        signature_status: 'unsigned',
        signature: null,
        summary: {
          active_agents: 0,
          total_agents: 0,
          queued_tasks: 0,
          in_progress_tasks: 0,
          warning_count_24h: 0,
          error_count_24h: 0,
        },
        warnings: ['Remote hub snapshot is temporarily unavailable.'],
      },
      { status: 200 },
    )
  }
}

