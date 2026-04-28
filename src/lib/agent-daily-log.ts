export interface AgentDailyLogActivity {
  id: number | string
  type: string
  description: string
  created_at: number
  data?: unknown
}

export interface AgentDailyLogMessage {
  id: number | string
  conversation_id: string
  from_agent: string
  to_agent?: string | null
  content: string
  message_type: string
  created_at: number
  metadata?: Record<string, unknown> | null
}

export interface AgentDailyLogEntry {
  dayKey: string
  label: string
  timestamp: number
  activityCount: number
  communicationCount: number
  learningCount: number
  toolCallCount: number
  peers: string[]
  actions: string[]
  learned: string[]
}

const LEARNING_TYPES = [
  'agent_memory_updated',
  'agent_memory_cleared',
  'memory_file_saved',
  'memory_file_created',
  'memory_file_deleted',
  'agent_soul_updated',
]

function dayKeyFromTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10)
}

function dayLabelFromTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function extractLearningText(activity: AgentDailyLogActivity): string {
  const data = activity.data && typeof activity.data === 'object' && !Array.isArray(activity.data)
    ? activity.data as Record<string, unknown>
    : null

  const candidates = [
    data?.summary,
    data?.memory,
    data?.value,
    data?.content,
    data?.note,
    data?.path,
    activity.description,
  ]

  for (const candidate of candidates) {
    const normalized = normalizeText(candidate)
    if (normalized) return normalized
  }

  return activity.type.replaceAll('_', ' ')
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
}

export function buildStableAgentThreadId(agentA: string, agentB: string): string {
  const ordered = [agentA.trim(), agentB.trim()]
    .filter(Boolean)
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()))
  return `a2a:${ordered.join(':')}`
}

export function isLearningActivity(type: string): boolean {
  return LEARNING_TYPES.includes(type) || type.includes('memory') || type.includes('learn') || type.includes('soul')
}

export function buildAgentDailyLogEntries(
  agentName: string,
  activities: AgentDailyLogActivity[],
  messages: AgentDailyLogMessage[],
): AgentDailyLogEntry[] {
  const grouped = new Map<string, {
    timestamp: number
    activities: AgentDailyLogActivity[]
    messages: AgentDailyLogMessage[]
  }>()

  for (const activity of activities) {
    const key = dayKeyFromTimestamp(activity.created_at)
    const existing = grouped.get(key) || {
      timestamp: activity.created_at,
      activities: [],
      messages: [],
    }
    existing.timestamp = Math.max(existing.timestamp, activity.created_at)
    existing.activities.push(activity)
    grouped.set(key, existing)
  }

  for (const message of messages) {
    const key = dayKeyFromTimestamp(message.created_at)
    const existing = grouped.get(key) || {
      timestamp: message.created_at,
      activities: [],
      messages: [],
    }
    existing.timestamp = Math.max(existing.timestamp, message.created_at)
    existing.messages.push(message)
    grouped.set(key, existing)
  }

  return [...grouped.entries()]
    .map(([dayKey, day]) => {
      const learningActivities = day.activities.filter((activity) => isLearningActivity(activity.type))
      const actionDescriptions = uniqueStrings(
        day.activities
          .filter((activity) => !isLearningActivity(activity.type))
          .map((activity) => activity.description),
      ).slice(0, 5)

      const learned = uniqueStrings(
        learningActivities.map((activity) => extractLearningText(activity)),
      ).slice(0, 5)

      const peers = uniqueStrings(
        day.messages.flatMap((message) => [
          message.from_agent.toLowerCase() === agentName.toLowerCase() ? message.to_agent || null : message.from_agent,
          message.to_agent?.toLowerCase() === agentName.toLowerCase() ? message.from_agent : null,
        ]),
      ).slice(0, 8)

      return {
        dayKey,
        label: dayLabelFromTimestamp(day.timestamp),
        timestamp: day.timestamp,
        activityCount: day.activities.length,
        communicationCount: day.messages.length,
        learningCount: learningActivities.length,
        toolCallCount: day.messages.filter((message) => message.message_type === 'tool_call').length,
        peers,
        actions: actionDescriptions,
        learned,
      }
    })
    .sort((left, right) => right.timestamp - left.timestamp)
}
