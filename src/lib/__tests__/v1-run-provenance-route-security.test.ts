import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  requireRoleMock,
  requireWorkspaceIdMock,
  getRunProvenanceMock,
} = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  requireWorkspaceIdMock: vi.fn(),
  getRunProvenanceMock: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  requireRole: requireRoleMock,
}))

vi.mock('@/lib/enforcement/workspace-scope', () => ({
  requireWorkspaceId: requireWorkspaceIdMock,
}))

vi.mock('@/lib/runs', () => ({
  getRunProvenance: getRunProvenanceMock,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

function request(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET' })
}

describe('v1 run provenance route security', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    requireRoleMock.mockReturnValue({
      user: { username: 'viewer', role: 'viewer', workspace_id: 7 },
    })
    requireWorkspaceIdMock.mockReturnValue({ workspaceId: 7 })
  })

  it('denies unauthenticated access', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const { GET } = await import('@/app/api/v1/runs/[run_id]/provenance/route')
    const response = await GET(
      request('http://localhost/api/v1/runs/run-1/provenance'),
      { params: Promise.resolve({ run_id: 'run-1' }) },
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('fails closed when workspace context is missing', async () => {
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { GET } = await import('@/app/api/v1/runs/[run_id]/provenance/route')
    const response = await GET(
      request('http://localhost/api/v1/runs/run-1/provenance'),
      { params: Promise.resolve({ run_id: 'run-1' }) },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Workspace context required' })
    expect(getRunProvenanceMock).not.toHaveBeenCalled()
  })

  it('returns workspace-scoped provenance for authorized access', async () => {
    getRunProvenanceMock.mockReturnValueOnce({
      run_hash: 'abc123',
      runtime: 'codex',
    })

    const { GET } = await import('@/app/api/v1/runs/[run_id]/provenance/route')
    const response = await GET(
      request('http://localhost/api/v1/runs/run-1/provenance'),
      { params: Promise.resolve({ run_id: 'run-1' }) },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Agent-Run-Protocol')).toBe('0.1.0')
    expect(await response.json()).toEqual({
      run_hash: 'abc123',
      runtime: 'codex',
    })
    expect(getRunProvenanceMock).toHaveBeenCalledWith('run-1', 7)
  })

  it('does not allow cross-workspace provenance access', async () => {
    getRunProvenanceMock.mockReturnValueOnce(null)

    const { GET } = await import('@/app/api/v1/runs/[run_id]/provenance/route')
    const response = await GET(
      request('http://localhost/api/v1/runs/run-999/provenance'),
      { params: Promise.resolve({ run_id: 'run-999' }) },
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Run not found' })
    expect(getRunProvenanceMock).toHaveBeenCalledWith('run-999', 7)
  })

  it('route source no longer contains workspace fallback to 1', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile('src/app/api/v1/runs/[run_id]/provenance/route.ts', 'utf8')

    expect(source).not.toContain('workspace_id ?? 1')
    expect(source).not.toContain('workspaceId ?? 1')
  })
})
