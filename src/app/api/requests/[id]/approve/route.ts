import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { requireWorkspaceId } from '@/lib/enforcement/workspace-scope'
import { approve } from '@/lib/request-gateway'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const wsResult = requireWorkspaceId(auth.user)
  if (!('workspaceId' in wsResult)) return wsResult.response

  try {
    const body = await request.json()
    const { id } = await params

    if (!body?.request || body.request.id !== id) {
      throw new Error('Request id does not match route id.')
    }

    const updated = approve(body.request)
    return NextResponse.json({ request: updated }, { status: 200 })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid request.' },
      { status: 400 },
    )
  }
}
