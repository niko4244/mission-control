import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const requireRoleMock = vi.fn()
const prepareMock = vi.fn()
const runMock = vi.fn()

vi.mock('@/lib/auth', () => ({
  requireRole: requireRoleMock,
}))

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({
    prepare: prepareMock,
  })),
}))

vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}))

describe('hub status route', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    prepareMock.mockImplementation((sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

      if (normalized.includes('from agents')) {
        return {
          get: vi.fn(() => ({
            total_agents: 2,
            active_agents: 2,
            busy_agents: 1,
            error_agents: 0,
            recent_heartbeat_count: 2,
            stale_agents: 0,
          })),
          run: runMock,
        }
      }

      if (normalized.includes('from tasks')) {
        return {
          get: vi.fn(() => ({
            queued_tasks: 3,
            in_progress_tasks: 1,
            review_tasks: 1,
            failed_tasks: 0,
          })),
          run: runMock,
        }
      }

      if (normalized.includes('from audit_log')) {
        return {
          get: vi.fn(() => ({ c: 1 })),
          run: runMock,
        }
      }

      if (normalized.includes('from activities')) {
        return {
          get: vi.fn(() => ({ c: 2 })),
          run: runMock,
        }
      }

      return {
        get: vi.fn(() => ({ c: 0 })),
        all: vi.fn(() => []),
        run: runMock,
      }
    })
  })

  it('denies unauthenticated requests', async () => {
    requireRoleMock.mockReturnValue({ error: 'Authentication required', status: 401 })

    const { GET } = await import('@/app/api/hub/status/route')
    const response = await GET(new NextRequest('http://localhost/api/hub/status'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'Authentication required' })
  })

  it('fails closed when workspace context is missing', async () => {
    requireRoleMock.mockReturnValue({
      user: { username: 'viewer', role: 'viewer', workspace_id: 0 },
    })

    const { GET } = await import('@/app/api/hub/status/route')
    const response = await GET(new NextRequest('http://localhost/api/hub/status'))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Workspace context required' })
  })

  it('returns sanitized read-only status for authenticated requests', async () => {
    requireRoleMock.mockReturnValue({
      user: { username: 'viewer', role: 'viewer', workspace_id: 7, tenant_id: 1 },
    })

    const { GET } = await import('@/app/api/hub/status/route')
    const response = await GET(new NextRequest('http://localhost/api/hub/status'))
    const payload = await response.json()
    const encoded = JSON.stringify(payload).toLowerCase()

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      hub_status: expect.stringMatching(/PASS|WARN|FAIL/),
      git: expect.objectContaining({
        branch: expect.anything(),
        commit: expect.anything(),
      }),
      heartbeat_summary: expect.objectContaining({
        total_agents: 2,
        active_agents: 2,
      }),
      task_queue_summary: expect.objectContaining({
        queued_tasks: 3,
        in_progress_tasks: 1,
      }),
    })
    expect(encoded).not.toContain('api_key')
    expect(encoded).not.toContain('token')
    expect(encoded).not.toContain('secret')
    expect(encoded).not.toContain('cookie')
    expect(runMock).not.toHaveBeenCalled()
  })
})
