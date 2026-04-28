import type { Agent } from '@/store'

export interface CompanionSuggestion {
  id: string
  label: string
  prompt: string
  kind: 'chat' | 'navigate'
  tab?: string
}

export interface CompanionBrief {
  headline: string
  summary: string
  status: string
  targetAgent: string
  suggestions: CompanionSuggestion[]
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function resolveCompanionTargetAgent(agents: Agent[]): string {
  const orchestrator = agents.find((agent) => /(orchestrator|coordinator|operator|strategist)/i.test(agent.role || ''))
  if (orchestrator) return orchestrator.name
  const coordinator = agents.find((agent) => agent.name.toLowerCase() === 'coordinator')
  if (coordinator) return coordinator.name
  return 'coordinator'
}

export function buildCompanionBrief(input: {
  activeTab: string
  agents: Agent[]
  unreadNotifications: number
  unreadConversations: number
}): CompanionBrief {
  const { activeTab, agents, unreadNotifications, unreadConversations } = input
  const busyAgents = agents.filter((agent) => agent.status === 'busy').length
  const offlineAgents = agents.filter((agent) => agent.status === 'offline').length
  const targetAgent = resolveCompanionTargetAgent(agents)

  const base: CompanionBrief = {
    headline: 'I’m here if you need me.',
    summary: 'I can stay out of the way, or I can open the coordinator thread and help route work.',
    status: `${pluralize(busyAgents, 'agent is', 'agents are')} busy`,
    targetAgent,
    suggestions: [
      {
        id: 'overview-brief',
        label: 'Brief me',
        prompt: 'Give me a concise status briefing on the system, active agents, and the most important next action.',
        kind: 'chat',
      },
      {
        id: 'go-agents',
        label: 'Open agents',
        prompt: '',
        kind: 'navigate',
        tab: 'agents',
      },
      {
        id: 'go-tasks',
        label: 'Open tasks',
        prompt: '',
        kind: 'navigate',
        tab: 'tasks',
      },
    ],
  }

  if (unreadNotifications > 0) {
    base.headline = 'You have active signals waiting.'
    base.summary = `I’m seeing ${pluralize(unreadNotifications, 'unread notification', 'unread notifications')}. Want me to summarize what matters?`
    base.status = `${pluralize(unreadNotifications, 'alert', 'alerts')} pending`
    base.suggestions[0] = {
      id: 'triage-alerts',
      label: 'Triage alerts',
      prompt: 'Summarize the unread alerts and tell me which one needs attention first.',
      kind: 'chat',
    }
  }

  if (activeTab === 'agents') {
    base.headline = 'Your team is assembled.'
    base.summary = busyAgents > 0
      ? `${pluralize(busyAgents, 'agent is', 'agents are')} actively working. I can help coordinate or open a direct thread.`
      : 'I can review load, routing, and communication paths across the agents.'
    base.status = `${pluralize(offlineAgents, 'agent is', 'agents are')} offline`
    base.suggestions = [
      {
        id: 'agent-load',
        label: 'Review load',
        prompt: 'Review current agent load, identify bottlenecks, and recommend the next handoff.',
        kind: 'chat',
      },
      {
        id: 'agent-daily-log',
        label: 'Daily logs',
        prompt: '',
        kind: 'navigate',
        tab: 'agents',
      },
      {
        id: 'agent-comms',
        label: 'Open comms',
        prompt: '',
        kind: 'navigate',
        tab: 'overview',
      },
    ]
  } else if (activeTab === 'tasks') {
    base.headline = 'Need help untangling the board?'
    base.summary = 'I can scan for blockers, route a task to the right agent, or write a quick execution plan.'
    base.status = unreadConversations > 0
      ? `${pluralize(unreadConversations, 'chat thread is', 'chat threads are')} active`
      : 'Task board ready'
    base.suggestions = [
      {
        id: 'task-blockers',
        label: 'Find blockers',
        prompt: 'Look across the task board and tell me what is blocked, stale, or needs reassignment.',
        kind: 'chat',
      },
      {
        id: 'task-plan',
        label: 'Make a plan',
        prompt: 'Help me turn the current task situation into a short next-step plan.',
        kind: 'chat',
      },
      {
        id: 'task-activity',
        label: 'See activity',
        prompt: '',
        kind: 'navigate',
        tab: 'activity',
      },
    ]
  } else if (activeTab === 'activity' || activeTab === 'logs') {
    base.headline = 'There’s a lot happening.'
    base.summary = 'I can compress the noise into a daily story: what changed, what was learned, and what needs a follow-up.'
    base.status = `${pluralize(busyAgents, 'agent is', 'agents are')} active right now`
    base.suggestions = [
      {
        id: 'summarize-activity',
        label: 'Summarize today',
        prompt: 'Summarize today’s agent activity, direct communications, and learning updates into a crisp daily log.',
        kind: 'chat',
      },
      {
        id: 'open-overview',
        label: 'Open overview',
        prompt: '',
        kind: 'navigate',
        tab: 'overview',
      },
      {
        id: 'open-agents',
        label: 'Open agents',
        prompt: '',
        kind: 'navigate',
        tab: 'agents',
      },
    ]
  } else if (activeTab === 'settings') {
    base.headline = 'Tweaking the machine?'
    base.summary = 'I can help audit risky settings changes before they turn into weird runtime behavior.'
    base.status = `${pluralize(offlineAgents, 'agent is', 'agents are')} offline`
    base.suggestions = [
      {
        id: 'settings-audit',
        label: 'Audit settings',
        prompt: 'Review the current settings context and point out any risky or high-impact changes to double-check.',
        kind: 'chat',
      },
      {
        id: 'open-overview-settings',
        label: 'Open overview',
        prompt: '',
        kind: 'navigate',
        tab: 'overview',
      },
      {
        id: 'open-logs-settings',
        label: 'Open logs',
        prompt: '',
        kind: 'navigate',
        tab: 'logs',
      },
    ]
  }

  return base
}
