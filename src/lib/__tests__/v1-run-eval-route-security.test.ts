import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const {
  requireRoleMock,
  requireWorkspaceIdMock,
  attachEvalMock,
} = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  requireWorkspaceIdMock: vi.fn(),
  attachEvalMock: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  requireRole: requireRoleMock,
}))

vi.mock('@/lib/enforcement/workspace-scope', () => ({
  requireWorkspaceId: requireWorkspaceIdMock,
}))

vi.mock('@/lib/runs', () => ({
  attachEval: attachEvalMock,
}))

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('v1 run eval route security', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    requireRoleMock.mockReturnValue({
      user: { username: 'operator', role: 'operator', workspace_id: 7 },
    })
    requireWorkspaceIdMock.mockReturnValue({ workspaceId: 7 })
  })

  it('denies unauthenticated access', async () => {
    requireRoleMock.mockReturnValueOnce({ error: 'Authentication required', status: 401 })

    const { PUT } = await import('@/app/api/v1/runs/[run_id]/eval/route')
    const response = await PUT(
      jsonRequest('http://localhost/api/v1/runs/run-1/eval', { pass: true, score: 0.9 }),
      { params: Promise.resolve({ run_id: 'run-1' }) },
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
  })

  it('fails closed when workspace context is missing', async () => {
    requireWorkspaceIdMock.mockReturnValueOnce({
      response: Response.json({ error: 'Workspace context required' }, { status: 400 }),
    })

    const { PUT } = await import('@/app/api/v1/runs/[run_id]/eval/route')
    const response = await PUT(
      jsonRequest('http://localhost/api/v1/runs/run-1/eval', { pass: true, score: 0.9 }),
      { params: Promise.resolve({ run_id: 'run-1' }) },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Workspace context required' })
    expect(attachEvalMock).not.toHaveBeenCalled()
  })

  it('allows authorized workspace-scoped eval updates', async () => {
    attachEvalMock.mockReturnValueOnce({
      id: 'run-1',
      eval_pass: true,
      eval_score: 0.9,
      workspace_id: '7',
    })

    const { PUT } = await import('@/app/api/v1/runs/[run_id]/eval/route')
    const response = await PUT(
      jsonRequest('http://localhost/api/v1/runs/run-1/eval', {
        pass: true,
        score: 0.9,
        notes: 'Looks good',
      }),
      { params: Promise.resolve({ run_id: 'run-1' }) },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Agent-Run-Protocol')).toBe('0.1.0')
    expect(await response.json()).toEqual({
      id: 'run-1',
      eval_pass: true,
      eval_score: 0.9,
      workspace_id: '7',
    })
    expect(attachEvalMock).toHaveBeenCalledWith('run-1', {
      pass: true,
      score: 0.9,
      notes: 'Looks good',
    }, 7)
  })

  it('does not allow cross-workspace eval access', async () => {
    attachEvalMock.mockReturnValueOnce(null)

    const { PUT } = await import('@/app/api/v1/runs/[run_id]/eval/route')
    const response = await PUT(
      jsonRequest('http://localhost/api/v1/runs/run-999/eval', { pass: false, score: 0.1 }),
      { params: Promise.resolve({ run_id: 'run-999' }) },
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Run not found' })
    expect(attachEvalMock).toHaveBeenCalledWith('run-999', {
      pass: false,
      score: 0.1,
    }, 7)
  })

  it('route source no longer contains workspace fallback to 1', async () => {
    const fs = await import('node:fs/promises')
    const source = await fs.readFile('src/app/api/v1/runs/[run_id]/eval/route.ts', 'utf8')

    expect(source).not.toContain('workspace_id ?? 1')
    expect(source).not.toContain('workspaceId ?? 1')
  })
})
