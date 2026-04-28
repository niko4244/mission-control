'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useMissionControl } from '@/store'
import { buildCompanionBrief } from '@/lib/ambient-companion'

const STORAGE_KEY = 'mc.ambient-companion.collapsed'

export function AmbientCompanion() {
  const {
    activeTab,
    agents,
    notifications,
    conversations,
    chatPanelOpen,
    setActiveConversation,
    setChatInput,
    setChatPanelOpen,
    setActiveTab,
  } = useMissionControl()

  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(STORAGE_KEY) === '1')
    } catch {
      setCollapsed(false)
    }
  }, [])

  const unreadNotifications = notifications.filter((notification) => !notification.read_at).length
  const unreadConversations = conversations.filter((conversation) => (conversation.unreadCount || 0) > 0).length

  const brief = useMemo(() => buildCompanionBrief({
    activeTab,
    agents,
    unreadNotifications,
    unreadConversations,
  }), [activeTab, agents, unreadNotifications, unreadConversations])

  const updateCollapsed = (value: boolean) => {
    setCollapsed(value)
    try {
      window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0')
    } catch {}
  }

  const openCoordinator = (prompt?: string) => {
    setActiveConversation(`agent_${brief.targetAgent}`)
    setChatInput(prompt || '')
    setChatPanelOpen(true)
  }

  if (chatPanelOpen) return null

  return (
    <div className="fixed bottom-5 right-5 z-30 hidden md:block">
      {collapsed ? (
        <button
          type="button"
          onClick={() => updateCollapsed(false)}
          className="group flex items-center gap-2 rounded-full border border-border/70 bg-card/95 px-3 py-2 shadow-[0_18px_50px_rgba(0,0,0,0.28)] backdrop-blur"
          title="Open OmniClip"
        >
          <PaperclipMark compact />
          <div className="text-left">
            <div className="text-xs font-medium text-foreground">OmniClip</div>
            <div className="text-[11px] text-muted-foreground">{brief.status}</div>
          </div>
        </button>
      ) : (
        <div className="w-[340px] rounded-[28px] border border-border/70 bg-card/95 p-4 shadow-[0_24px_80px_rgba(0,0,0,0.35)] backdrop-blur">
          <div className="flex items-start gap-3">
            <PaperclipMark />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-foreground">OmniClip</div>
                  <div className="text-[11px] uppercase tracking-[0.18em] text-primary/80">Always here</div>
                </div>
                <button
                  type="button"
                  onClick={() => updateCollapsed(true)}
                  className="rounded-full border border-border/60 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  Hide
                </button>
              </div>
              <div className="mt-3 rounded-2xl bg-surface-1/70 px-3 py-3">
                <div className="text-sm font-medium text-foreground">{brief.headline}</div>
                <div className="mt-1 text-sm leading-6 text-foreground/75">{brief.summary}</div>
              </div>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between gap-2 rounded-2xl border border-border/50 bg-surface-1/35 px-3 py-2">
            <div>
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">Status</div>
              <div className="text-sm text-foreground">{brief.status}</div>
            </div>
            <Button size="sm" onClick={() => openCoordinator()}>
              Talk to {brief.targetAgent}
            </Button>
          </div>

          <div className="mt-3">
            <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground mb-2">Try this</div>
            <div className="grid gap-2">
              {brief.suggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  onClick={() => {
                    if (suggestion.kind === 'navigate' && suggestion.tab) {
                      setActiveTab(suggestion.tab)
                      return
                    }
                    openCoordinator(suggestion.prompt)
                  }}
                  className="rounded-2xl border border-border/60 bg-card px-3 py-2 text-left hover:border-primary/40 hover:bg-primary/5 transition-colors"
                >
                  <div className="text-sm font-medium text-foreground">{suggestion.label}</div>
                  {suggestion.kind === 'chat' && (
                    <div className="mt-1 text-xs text-muted-foreground line-clamp-2">{suggestion.prompt}</div>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PaperclipMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`relative shrink-0 rounded-full border border-primary/25 bg-primary/10 ${compact ? 'h-10 w-10' : 'h-14 w-14'}`}>
      <svg
        viewBox="0 0 24 24"
        className={`absolute inset-0 m-auto text-primary ${compact ? 'h-5 w-5' : 'h-7 w-7'}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M9.5 12.5 15 7a3.5 3.5 0 0 1 5 5l-8.5 8.5a6 6 0 0 1-8.5-8.5L12 3" />
      </svg>
      <span className="absolute bottom-1.5 right-1.5 h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_18px_rgba(52,211,153,0.55)]" />
    </div>
  )
}
