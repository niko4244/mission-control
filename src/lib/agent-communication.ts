export interface AgentCommunicationConfig {
  mode?: 'isolated' | 'direct' | 'hybrid' | 'coordinator'
  canInitiateDirect?: boolean
  canReceiveDirect?: boolean
  allowedAgents?: string[]
  allowedRoles?: string[]
  preferredAgents?: string[]
}

type AgentRecordLike = {
  name?: string | null
  role?: string | null
  config?: unknown
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(
    value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )]
}

function normalizeToolList(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return normalizeStringArray((value as Record<string, unknown>).allow)
}

function normalizeDeniedToolList(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return normalizeStringArray((value as Record<string, unknown>).deny)
}

function parseConfig(config: unknown): Record<string, unknown> {
  if (!config) return {}
  if (typeof config === 'string') {
    try {
      const parsed = JSON.parse(config)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return {}
    }
    return {}
  }
  if (typeof config === 'object' && !Array.isArray(config)) {
    return config as Record<string, unknown>
  }
  return {}
}

function hasTool(tools: string[], denied: string[], toolName: string): boolean {
  return tools.includes(toolName) && !denied.includes(toolName)
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean)
}

function matchesRoleHint(role: string, hints: string[]): boolean {
  if (!role || hints.length === 0) return false
  const roleText = role.toLowerCase()
  const roleTokens = new Set(tokenize(role))
  return hints.some((hint) => {
    const cleaned = hint.trim().toLowerCase()
    if (!cleaned) return false
    if (roleText === cleaned || roleText.includes(cleaned)) return true
    return tokenize(cleaned).some((token) => roleTokens.has(token))
  })
}

export function getAgentCommunicationConfig(
  config: unknown,
  fallback?: Partial<AgentCommunicationConfig>,
): AgentCommunicationConfig {
  const configObj = parseConfig(config)
  const toolsAllow = normalizeToolList(configObj.tools)
  const toolsDeny = normalizeDeniedToolList(configObj.tools)
  const subagentAllowAgents = normalizeStringArray(
    configObj.subagents && typeof configObj.subagents === 'object'
      ? (configObj.subagents as Record<string, unknown>).allowAgents
      : undefined,
  )

  const base =
    configObj.communication && typeof configObj.communication === 'object' && !Array.isArray(configObj.communication)
      ? (configObj.communication as Record<string, unknown>)
      : {}

  const allowedAgents = normalizeStringArray(base.allowedAgents)
  const preferredAgents = normalizeStringArray(base.preferredAgents)
  const allowedRoles = normalizeStringArray(base.allowedRoles)

  const canSendByTool =
    hasTool(toolsAllow, toolsDeny, 'sessions_send') ||
    hasTool(toolsAllow, toolsDeny, 'chat.send') ||
    hasTool(toolsAllow, toolsDeny, 'subagents')

  const mode =
    typeof base.mode === 'string'
      ? (base.mode as AgentCommunicationConfig['mode'])
      : fallback?.mode || (canSendByTool ? 'direct' : 'isolated')

  const canInitiateDirect =
    typeof base.canInitiateDirect === 'boolean'
      ? base.canInitiateDirect
      : fallback?.canInitiateDirect ?? canSendByTool

  const canReceiveDirect =
    typeof base.canReceiveDirect === 'boolean'
      ? base.canReceiveDirect
      : fallback?.canReceiveDirect ?? true

  return {
    mode,
    canInitiateDirect,
    canReceiveDirect,
    allowedAgents: [...new Set([...(fallback?.allowedAgents || []), ...subagentAllowAgents, ...allowedAgents])],
    allowedRoles: [...new Set([...(fallback?.allowedRoles || []), ...allowedRoles])],
    preferredAgents: [...new Set([...(fallback?.preferredAgents || []), ...preferredAgents])],
  }
}

export function enrichConfigWithCommunication(
  config: unknown,
  fallback?: Partial<AgentCommunicationConfig>,
): Record<string, unknown> {
  const configObj = parseConfig(config)
  return {
    ...configObj,
    communication: getAgentCommunicationConfig(configObj, fallback),
  }
}

export function inferCommunicationFallback(
  name: string,
  role: string,
  soulContent?: string | null,
): Partial<AgentCommunicationConfig> {
  const text = `${name} ${role} ${soulContent || ''}`.toLowerCase()

  if (/(orchestrator|coordinator|router|manager|operator)/.test(text)) {
    return {
      mode: 'hybrid',
      canInitiateDirect: true,
      canReceiveDirect: true,
      allowedRoles: ['developer', 'builder', 'research', 'analyst', 'product', 'strategist', 'visual', 'design', 'reviewer', 'security', 'content'],
    }
  }

  if (/(developer|builder|engineer|coder|frontend|backend|devops|security|reviewer|research|analyst|product|strategist|visual|design|content)/.test(text)) {
    return {
      mode: 'direct',
      canInitiateDirect: true,
      canReceiveDirect: true,
      allowedRoles: ['orchestrator', 'coordinator', 'operator', 'developer', 'builder', 'research', 'analyst', 'product', 'strategist', 'visual', 'design', 'reviewer', 'security', 'content'],
    }
  }

  return {
    mode: 'isolated',
    canInitiateDirect: false,
    canReceiveDirect: true,
    allowedRoles: ['orchestrator', 'coordinator', 'operator'],
  }
}

export function canAgentsCommunicate(
  fromAgent: AgentRecordLike,
  toAgent: AgentRecordLike,
): { allowed: boolean; reason?: string } {
  const fromName = String(fromAgent.name || '').trim()
  const toName = String(toAgent.name || '').trim()
  if (!fromName || !toName) {
    return { allowed: false, reason: 'missing_agent_identity' }
  }
  if (fromName.toLowerCase() === toName.toLowerCase()) {
    return { allowed: false, reason: 'self_message_not_supported' }
  }

  const fromCommunication = getAgentCommunicationConfig(
    fromAgent.config,
    inferCommunicationFallback(fromName, String(fromAgent.role || 'agent')),
  )
  const toCommunication = getAgentCommunicationConfig(
    toAgent.config,
    inferCommunicationFallback(toName, String(toAgent.role || 'agent')),
  )

  if (!fromCommunication.canInitiateDirect) {
    return { allowed: false, reason: 'sender_direct_messaging_disabled' }
  }
  if (!toCommunication.canReceiveDirect) {
    return { allowed: false, reason: 'recipient_direct_messaging_disabled' }
  }

  const senderAllowsRecipient =
    fromCommunication.allowedAgents?.some((entry) => entry.toLowerCase() === toName.toLowerCase()) ||
    matchesRoleHint(String(toAgent.role || ''), fromCommunication.allowedRoles || [])

  const recipientAllowsSender =
    toCommunication.allowedAgents?.some((entry) => entry.toLowerCase() === fromName.toLowerCase()) ||
    matchesRoleHint(String(fromAgent.role || ''), toCommunication.allowedRoles || [])

  if (senderAllowsRecipient || recipientAllowsSender) {
    return { allowed: true }
  }

  return { allowed: false, reason: 'pair_not_allowed' }
}

export function isAgentToAgentRequest(options: {
  requestedFrom?: string | null
  conversationId?: string | null
  metadata?: Record<string, unknown> | null
  senderExists?: boolean
  recipientExists?: boolean
}): boolean {
  const requestedFrom = String(options.requestedFrom || '').trim()
  const conversationId = String(options.conversationId || '').trim().toLowerCase()
  const channel = typeof options.metadata?.channel === 'string' ? options.metadata.channel.toLowerCase() : ''

  return Boolean(
    requestedFrom &&
    options.senderExists &&
    options.recipientExists &&
    (conversationId.startsWith('a2a:') || channel === 'agent-to-agent' || options.metadata?.as_agent === true),
  )
}
