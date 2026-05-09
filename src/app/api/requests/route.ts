import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { requireWorkspaceId } from '@/lib/enforcement/workspace-scope'
import { createRequest } from '@/lib/request-gateway'

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const wsResult = requireWorkspaceId(auth.user)
  if (!('workspaceId' in wsResult)) return wsResult.response

  try {
    const input = await request.json()
    const created = createRequest(input)
    return NextResponse.json({ request: created }, { status: 200 })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Invalid request.' },
      { status: 400 },
    )
  }
}
