import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { requireWorkspaceId } from '@/lib/enforcement/workspace-scope'
import { attachEval } from '@/lib/runs'
import { logger } from '@/lib/logger'

/**
 * PUT /api/v1/runs/:run_id/eval — Attach or update an eval result.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ run_id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const wsResult = requireWorkspaceId(auth.user)
    if (!('workspaceId' in wsResult)) return wsResult.response

    const { run_id } = await params
    const body = await request.json()
    const { workspaceId } = wsResult

    if (body.pass === undefined || body.score === undefined) {
      return NextResponse.json(
        { error: 'Missing required fields: pass, score' },
        { status: 400 },
      )
    }

    const updated = attachEval(run_id, body, workspaceId)
    if (!updated) return NextResponse.json({ error: 'Run not found' }, { status: 404 })

    return NextResponse.json(updated, {
      headers: { 'X-Agent-Run-Protocol': '0.1.0' },
    })
  } catch (error) {
    logger.error({ err: error }, 'Failed to attach eval')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
