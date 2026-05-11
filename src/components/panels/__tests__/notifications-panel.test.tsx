import { act } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen } from '@testing-library/react'
import { NotificationsPanel } from '../notifications-panel'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock('@/lib/use-smart-poll', () => ({
  useSmartPoll: vi.fn(),
}))

vi.mock('@/components/ui/loader', () => ({
  Loader: ({ label }: { label?: string }) => <div>{label ?? 'Loading'}</div>,
}))

describe('NotificationsPanel hydration', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ notifications: [] }),
    } as Response))
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('hydrates cleanly when a saved recipient exists in localStorage', async () => {
    const originalWindow = globalThis.window
    localStorage.setItem('mc.notifications.recipient', 'ops@mission-control')

    vi.stubGlobal('window', undefined)
    const html = renderToString(<NotificationsPanel />)
    vi.stubGlobal('window', originalWindow)

    const container = document.createElement('div')
    container.innerHTML = html
    document.body.appendChild(container)

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await act(async () => {
      hydrateRoot(container, <NotificationsPanel />)
      await Promise.resolve()
    })

    const hydrationWarnings = consoleErrorSpy.mock.calls.filter((call) => {
      const message = call.map((value) => String(value)).join(' ')
      return message.includes('hydration') || message.includes("didn't match")
    })

    expect(hydrationWarnings).toHaveLength(0)
    expect(screen.getByRole('textbox')).toHaveValue('ops@mission-control')
    expect(global.fetch).toHaveBeenCalledWith('/api/notifications?recipient=ops%40mission-control')
  })
})
