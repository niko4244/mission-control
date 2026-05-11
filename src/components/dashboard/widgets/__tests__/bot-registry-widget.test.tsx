import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BotRegistryWidget } from '../bot-registry-widget'
import type { DashboardData } from '../../widget-primitives'

vi.mock('@/lib/use-smart-poll', () => ({
  useSmartPoll: vi.fn(),
}))

const mockNavigate = vi.fn()

const minimalData = {
  navigateToPanel: mockNavigate,
} as unknown as DashboardData

const mockRegistryData = {
  agent: 'Governance Status API v1',
  status: 'PASS' as const,
  timestamp: '2026-05-11T12:00:00.000Z',
  bot_registry: {
    implemented_count: 7,
    planned_count: 17,
    implemented: ['chief-arbiter', 'release-governor', 'security-governor', 'security-arbiter', 'security-executor', 'security-hardening-runner', 'task-router'],
    planned: ['architecture-governor', 'ci-sentinel', 'merge-steward', 'release-manager', 'documentation-governor', 'appliance-knowledge-governor'],
    hierarchy_warnings: [],
    blocking_conditions: [],
  },
  release_governor: {
    status: 'PASS',
    branch: 'main',
    working_tree_clean: true,
    warnings: [],
    blockers: [],
  },
  summary: {
    observe_only: true,
    governance_healthy: true,
    pending_bot_count: 17,
  },
}

function mockFetch(data: unknown) {
  vi.mocked(global.fetch).mockResolvedValue({
    ok: true,
    json: async () => data,
  } as Response)
}

describe('BotRegistryWidget', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    mockNavigate.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('shows loading state before data arrives', () => {
    vi.mocked(global.fetch).mockReturnValue(new Promise(() => {}))
    render(<BotRegistryWidget data={minimalData} />)
    expect(screen.getByText(/loading bot registry/i)).toBeInTheDocument()
  })

  it('shows fetch error when request fails', async () => {
    vi.mocked(global.fetch).mockRejectedValue(new Error('Network error'))
    render(<BotRegistryWidget data={minimalData} />)
    await vi.waitFor(() => {
      expect(screen.getByText(/network error/i)).toBeInTheDocument()
    })
  })

  it('renders implemented and pending counts after load', async () => {
    mockFetch(mockRegistryData)
    render(<BotRegistryWidget data={minimalData} />)
    await vi.waitFor(() => {
      expect(screen.getByText('7')).toBeInTheDocument()
      expect(screen.getByText('17')).toBeInTheDocument()
    })
  })

  it('shows PASS status badge', async () => {
    mockFetch(mockRegistryData)
    render(<BotRegistryWidget data={minimalData} />)
    await vi.waitFor(() => {
      expect(screen.getByText('PASS')).toBeInTheDocument()
    })
  })

  it('shows branch name from release governor', async () => {
    mockFetch(mockRegistryData)
    render(<BotRegistryWidget data={minimalData} />)
    await vi.waitFor(() => {
      expect(screen.getByText('main')).toBeInTheDocument()
    })
  })

  it('shows clean tree indicator', async () => {
    mockFetch(mockRegistryData)
    render(<BotRegistryWidget data={minimalData} />)
    await vi.waitFor(() => {
      expect(screen.getByText('clean')).toBeInTheDocument()
    })
  })

  it('shows dirty tree indicator when working tree dirty', async () => {
    mockFetch({ ...mockRegistryData, release_governor: { ...mockRegistryData.release_governor, working_tree_clean: false } })
    render(<BotRegistryWidget data={minimalData} />)
    await vi.waitFor(() => {
      expect(screen.getByText('dirty')).toBeInTheDocument()
    })
  })

  it('shows Show bots button', async () => {
    mockFetch(mockRegistryData)
    render(<BotRegistryWidget data={minimalData} />)
    await vi.waitFor(() => {
      expect(screen.getByRole('button', { name: /toggle bot list/i })).toBeInTheDocument()
    })
  })

  it('expands to show bot lists when Show bots clicked', async () => {
    mockFetch(mockRegistryData)
    render(<BotRegistryWidget data={minimalData} />)
    await vi.waitFor(() => {
      const btn = screen.getByRole('button', { name: /toggle bot list/i })
      fireEvent.click(btn)
    })
    expect(screen.getByText('chief-arbiter')).toBeInTheDocument()
    expect(screen.getByText('architecture-governor')).toBeInTheDocument()
  })

  it('shows hierarchy warnings when present', async () => {
    mockFetch({
      ...mockRegistryData,
      status: 'WARN',
      bot_registry: { ...mockRegistryData.bot_registry, hierarchy_warnings: ['bot-x reports to unknown'] },
    })
    render(<BotRegistryWidget data={minimalData} />)
    await vi.waitFor(() => {
      expect(screen.getByText(/hierarchy warning/i)).toBeInTheDocument()
    })
  })

  it('navigates to mc-status panel on Details click', async () => {
    mockFetch(mockRegistryData)
    render(<BotRegistryWidget data={minimalData} />)
    await vi.waitFor(() => {
      const btn = screen.getByText('Details →')
      fireEvent.click(btn)
      expect(mockNavigate).toHaveBeenCalledWith('mc-status')
    })
  })
})
