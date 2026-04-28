/**
 * Agent Templates Library
 *
 * Defines agent archetypes that can be used as starting points for new deployments.
 * Each template provides a full OpenClaw agent config structure that
 * can be customized before creating an agent.
 */

import type { AgentCommunicationConfig } from '@/lib/agent-communication'
import { getPluginToolProviders } from '@/lib/plugins'

export interface AgentToolsConfig {
  allow: string[]
  deny: string[]
}

export interface AgentSandboxConfig {
  mode: 'all' | 'non-main'
  workspaceAccess: 'rw' | 'ro' | 'none'
  scope: 'agent'
  docker?: {
    network: 'none' | 'bridge'
  }
}

export interface AgentModelConfig {
  primary: string
  fallbacks: string[]
}

export interface AgentIdentityConfig {
  name: string
  theme: string
  emoji: string
}

export interface AgentSubagentsConfig {
  allowAgents?: string[]
  model?: string
}

export interface AgentMemorySearchConfig {
  sources: string[]
  experimental?: {
    sessionMemory?: boolean
  }
}

export interface OpenClawAgentConfig {
  id: string
  name?: string
  workspace?: string
  agentDir?: string
  model: AgentModelConfig
  identity: AgentIdentityConfig
  subagents?: AgentSubagentsConfig
  sandbox: AgentSandboxConfig
  tools: AgentToolsConfig
  memorySearch?: AgentMemorySearchConfig
  communication?: AgentCommunicationConfig
  workloadLanes?: string[]
  functions?: string[]
  skills?: string[]
  abilities?: string[]
  capabilities?: string[]
}

export interface AgentTemplate {
  type: string
  label: string
  description: string
  emoji: string
  modelTier: 'opus' | 'sonnet' | 'haiku'
  toolCount: number
  config: Omit<OpenClawAgentConfig, 'id' | 'workspace' | 'agentDir'>
}

// Tool groups for template composition
const TOOL_GROUPS: Record<string, readonly string[]> = {
  coding: ['read', 'write', 'edit', 'apply_patch', 'exec', 'bash', 'process'],
  browser: ['browser', 'web'],
  memory: ['memory_search', 'memory_get'],
  session: ['agents_list', 'sessions_list', 'sessions_history', 'sessions_send', 'sessions_spawn', 'session_status'],
  subagent: ['subagents', 'lobster', 'llm-task'],
  thinking: ['thinking', 'reactions', 'skills'],
  readonly: ['read', 'memory_search', 'memory_get', 'agents_list'],
}

/** Merge base TOOL_GROUPS with tools from plugin tool providers */
export function getEffectiveToolGroups(): Record<string, readonly string[]> {
  const merged: Record<string, string[]> = {}
  for (const [key, tools] of Object.entries(TOOL_GROUPS)) {
    merged[key] = [...tools]
  }
  for (const provider of getPluginToolProviders()) {
    const groupId = provider.id
    if (merged[groupId]) {
      // Append new tools that aren't already in the group
      const existing = new Set(merged[groupId])
      for (const tool of provider.tools) {
        if (!existing.has(tool)) merged[groupId].push(tool)
      }
    } else {
      merged[groupId] = [...provider.tools]
    }
  }
  return merged
}

const COMMON_DENY = ['clawhub', 'cron', 'gateway', 'nodes']

const SONNET_FALLBACKS = [
  'openrouter/anthropic/claude-sonnet-4',
  'moonshot/kimi-k2-thinking',
  'openrouter/moonshotai/kimi-k2.5',
  'nvidia/moonshotai/kimi-k2-instruct',
  'openai/codex-mini-latest',
  'ollama/qwen2.5-coder:14b',
]

const OPUS_FALLBACKS = [
  'anthropic/claude-sonnet-4-20250514',
  'moonshot/kimi-k2-thinking',
  'nvidia/moonshotai/kimi-k2-instruct',
  'openrouter/moonshotai/kimi-k2.5',
  'openai/codex-mini-latest',
]

const HAIKU_FALLBACKS = [
  'anthropic/claude-sonnet-4-20250514',
  'ollama/qwen2.5-coder:14b',
  'openai/codex-mini-latest',
]

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    type: 'orchestrator',
    label: 'Orchestrator',
    description: 'Primary coordinator with full tool access. Routes tasks to specialist agents and manages workflows.',
    emoji: '\ud83e\udded',
    modelTier: 'opus',
    toolCount: 23,
    config: {
      model: {
        primary: 'anthropic/claude-opus-4-5',
        fallbacks: OPUS_FALLBACKS,
      },
      identity: {
        name: '',
        theme: 'operator strategist',
        emoji: '\ud83e\udded',
      },
      subagents: {
        allowAgents: [],
      },
      sandbox: {
        mode: 'non-main',
        workspaceAccess: 'rw',
        scope: 'agent',
      },
      tools: {
        allow: [
          ...TOOL_GROUPS.coding,
          ...TOOL_GROUPS.browser,
          ...TOOL_GROUPS.memory,
          ...TOOL_GROUPS.session,
          ...TOOL_GROUPS.subagent,
          ...TOOL_GROUPS.thinking,
        ],
        deny: COMMON_DENY,
      },
      memorySearch: {
        sources: ['memory', 'sessions'],
        experimental: { sessionMemory: true },
      },
      communication: {
        mode: 'hybrid',
        canInitiateDirect: true,
        canReceiveDirect: true,
        allowedRoles: ['developer', 'builder', 'research', 'analyst', 'product', 'strategist', 'visual', 'design', 'reviewer', 'security', 'content'],
      },
      workloadLanes: ['tool_routing', 'lookup', 'coding', 'research', 'product_conception', 'image_prompting'],
      functions: ['tool_routing', 'search', 'code_execution', 'research_synthesis', 'product_framing', 'image_direction'],
      skills: ['task_decomposition', 'routing', 'recommendation', 'coordination'],
      abilities: ['freshness_awareness', 'tool_selection', 'grounded_uncertainty'],
      capabilities: ['lookup', 'coding', 'research', 'product_conception', 'image_prompting', 'tool_routing', 'agent_communication', 'coordination'],
    },
  },
  {
    type: 'developer',
    label: 'Developer',
    description: 'Full-stack builder with Docker bridge networking, exec/write access, and subagent spawning.',
    emoji: '\ud83d\udee0\ufe0f',
    modelTier: 'sonnet',
    toolCount: 21,
    config: {
      model: {
        primary: 'anthropic/claude-sonnet-4-20250514',
        fallbacks: SONNET_FALLBACKS,
      },
      identity: {
        name: '',
        theme: 'builder engineer',
        emoji: '\ud83d\udee0\ufe0f',
      },
      subagents: {
        allowAgents: [],
        model: 'openai/codex-mini-latest',
      },
      sandbox: {
        mode: 'all',
        workspaceAccess: 'rw',
        scope: 'agent',
        docker: { network: 'bridge' },
      },
      tools: {
        allow: [
          ...TOOL_GROUPS.coding,
          ...TOOL_GROUPS.browser,
          ...TOOL_GROUPS.memory,
          'agents_list', 'sessions_send', 'sessions_spawn', 'sessions_history', 'session_status',
          ...TOOL_GROUPS.subagent,
          ...TOOL_GROUPS.thinking,
        ],
        deny: COMMON_DENY,
      },
      memorySearch: {
        sources: ['memory', 'sessions'],
        experimental: { sessionMemory: true },
      },
      communication: {
        mode: 'direct',
        canInitiateDirect: true,
        canReceiveDirect: true,
        allowedRoles: ['orchestrator', 'coordinator', 'operator', 'developer', 'builder', 'reviewer', 'research', 'analyst'],
      },
      workloadLanes: ['coding', 'tool_routing'],
      functions: ['code_execution', 'implementation_planning'],
      skills: ['debugging', 'implementation_planning', 'testing'],
      abilities: ['code_tool_use', 'concise_reasoning'],
      capabilities: ['coding', 'debugging', 'implementation', 'tests', 'agent_communication'],
    },
  },
  {
    type: 'specialist-dev',
    label: 'Specialist Dev',
    description: 'Focused developer for specific domains (frontend, backend, blockchain). Docker bridge + write access.',
    emoji: '\u2699\ufe0f',
    modelTier: 'sonnet',
    toolCount: 15,
    config: {
      model: {
        primary: 'anthropic/claude-sonnet-4-20250514',
        fallbacks: SONNET_FALLBACKS,
      },
      identity: {
        name: '',
        theme: 'specialist developer',
        emoji: '\u2699\ufe0f',
      },
      subagents: {
        model: 'openai/codex-mini-latest',
      },
      sandbox: {
        mode: 'all',
        workspaceAccess: 'rw',
        scope: 'agent',
        docker: { network: 'bridge' },
      },
      tools: {
        allow: [
          ...TOOL_GROUPS.coding,
          ...TOOL_GROUPS.memory,
          'agents_list', 'sessions_send', 'sessions_spawn', 'session_status',
          'subagents', 'llm-task',
          'thinking', 'reactions', 'skills',
        ],
        deny: [...COMMON_DENY, 'browser', 'web', 'lobster'],
      },
      memorySearch: {
        sources: ['memory', 'sessions'],
        experimental: { sessionMemory: true },
      },
      communication: {
        mode: 'direct',
        canInitiateDirect: true,
        canReceiveDirect: true,
        allowedRoles: ['orchestrator', 'coordinator', 'operator', 'developer', 'builder', 'reviewer'],
      },
      workloadLanes: ['coding'],
      functions: ['code_execution', 'implementation_planning'],
      skills: ['debugging', 'implementation_planning'],
      abilities: ['code_tool_use', 'grounded_uncertainty'],
      capabilities: ['coding', 'debugging', 'api', 'component', 'tests', 'agent_communication'],
    },
  },
  {
    type: 'reviewer',
    label: 'Reviewer / QA',
    description: 'Read-only access for code review, quality gates, and auditing. Lightweight Haiku model.',
    emoji: '\ud83d\udd2c',
    modelTier: 'haiku',
    toolCount: 7,
    config: {
      model: {
        primary: 'anthropic/claude-haiku-4-5',
        fallbacks: HAIKU_FALLBACKS,
      },
      identity: {
        name: '',
        theme: 'quality reviewer',
        emoji: '\ud83d\udd2c',
      },
      sandbox: {
        mode: 'all',
        workspaceAccess: 'ro',
        scope: 'agent',
      },
      tools: {
        allow: [
          'read', 'memory_search', 'memory_get',
          'sessions_send',
          'agents_list', 'thinking', 'reactions', 'skills',
        ],
        deny: [
          ...COMMON_DENY,
          'write', 'edit', 'apply_patch', 'exec', 'bash', 'process',
          'browser', 'web', 'sessions_spawn', 'lobster',
        ],
      },
      memorySearch: {
        sources: ['memory'],
      },
      communication: {
        mode: 'direct',
        canInitiateDirect: true,
        canReceiveDirect: true,
        allowedRoles: ['orchestrator', 'coordinator', 'operator', 'developer', 'builder', 'security'],
      },
      capabilities: ['review', 'qa', 'agent_communication'],
    },
  },
  {
    type: 'researcher',
    label: 'Researcher',
    description: 'Browser and web access for research tasks. No workspace or code execution.',
    emoji: '\ud83d\udd0d',
    modelTier: 'sonnet',
    toolCount: 8,
    config: {
      model: {
        primary: 'anthropic/claude-sonnet-4-20250514',
        fallbacks: SONNET_FALLBACKS,
      },
      identity: {
        name: '',
        theme: 'research analyst',
        emoji: '\ud83d\udd0d',
      },
      sandbox: {
        mode: 'all',
        workspaceAccess: 'none',
        scope: 'agent',
      },
      tools: {
        allow: [
          'browser', 'web',
          'memory_search', 'memory_get',
          'agents_list', 'sessions_send', 'thinking', 'reactions', 'skills',
        ],
        deny: [
          ...COMMON_DENY,
          'read', 'write', 'edit', 'apply_patch', 'exec', 'bash', 'process',
          'sessions_spawn', 'lobster',
        ],
      },
      memorySearch: {
        sources: ['memory', 'sessions'],
      },
      communication: {
        mode: 'direct',
        canInitiateDirect: true,
        canReceiveDirect: true,
        allowedRoles: ['orchestrator', 'coordinator', 'operator', 'developer', 'builder', 'product', 'strategist'],
      },
      workloadLanes: ['lookup', 'research'],
      functions: ['search', 'research_synthesis'],
      skills: ['source_grounded_synthesis', 'tradeoff_analysis'],
      abilities: ['freshness_awareness', 'grounded_uncertainty'],
      capabilities: ['lookup', 'research', 'analysis', 'comparison', 'agent_communication'],
    },
  },
  {
    type: 'content-creator',
    label: 'Content Creator',
    description: 'Write and edit access for content generation. No code execution or browser.',
    emoji: '\u270f\ufe0f',
    modelTier: 'haiku',
    toolCount: 9,
    config: {
      model: {
        primary: 'anthropic/claude-haiku-4-5',
        fallbacks: HAIKU_FALLBACKS,
      },
      identity: {
        name: '',
        theme: 'content creator',
        emoji: '\u270f\ufe0f',
      },
      sandbox: {
        mode: 'all',
        workspaceAccess: 'none',
        scope: 'agent',
      },
      tools: {
        allow: [
          'write', 'edit',
          'memory_search', 'memory_get',
          'agents_list',
          'sessions_send', 'thinking', 'reactions', 'skills',
          'web',
        ],
        deny: [
          ...COMMON_DENY,
          'read', 'apply_patch', 'exec', 'bash', 'process',
          'browser', 'sessions_spawn', 'lobster',
          'subagents', 'llm-task',
        ],
      },
      memorySearch: {
        sources: ['memory'],
      },
      communication: {
        mode: 'direct',
        canInitiateDirect: true,
        canReceiveDirect: true,
        allowedRoles: ['orchestrator', 'coordinator', 'operator', 'product', 'strategist', 'visual', 'design'],
      },
      capabilities: ['content', 'copywriting', 'agent_communication'],
    },
  },
  {
    type: 'security-auditor',
    label: 'Security Auditor',
    description: 'Read-only workspace with bash for security scanning. No write access to prevent tampering.',
    emoji: '\ud83d\udee1\ufe0f',
    modelTier: 'sonnet',
    toolCount: 10,
    config: {
      model: {
        primary: 'anthropic/claude-sonnet-4-20250514',
        fallbacks: SONNET_FALLBACKS,
      },
      identity: {
        name: '',
        theme: 'security auditor',
        emoji: '\ud83d\udee1\ufe0f',
      },
      sandbox: {
        mode: 'all',
        workspaceAccess: 'ro',
        scope: 'agent',
      },
      tools: {
        allow: [
          'read', 'exec', 'bash',
          'memory_search', 'memory_get',
          'agents_list', 'sessions_send',
          'thinking', 'reactions', 'skills',
          'web',
        ],
        deny: [
          ...COMMON_DENY,
          'write', 'edit', 'apply_patch', 'process',
          'browser', 'sessions_spawn', 'lobster',
          'subagents', 'llm-task',
        ],
      },
      memorySearch: {
        sources: ['memory'],
      },
      communication: {
        mode: 'direct',
        canInitiateDirect: true,
        canReceiveDirect: true,
        allowedRoles: ['orchestrator', 'coordinator', 'operator', 'developer', 'builder', 'reviewer'],
      },
      workloadLanes: ['product_conception', 'image_prompting'],
      functions: ['product_framing', 'image_direction'],
      skills: ['feature_structuring', 'visual_direction', 'prompt_iteration'],
      abilities: ['recommendation_under_uncertainty', 'image_handoff'],
      capabilities: ['product', 'feature_spec', 'image_prompting', 'visual_taste', 'agent_communication'],
    },
  },
  {
    type: 'product-strategist',
    label: 'Product Strategist',
    description: 'Sharp product framing, MVP shaping, wedge selection, and feature specification.',
    emoji: '\ud83e\uddf0',
    modelTier: 'sonnet',
    toolCount: 10,
    config: {
      model: {
        primary: 'anthropic/claude-sonnet-4-20250514',
        fallbacks: SONNET_FALLBACKS,
      },
      identity: {
        name: '',
        theme: 'product strategist',
        emoji: '\ud83e\uddf0',
      },
      sandbox: {
        mode: 'all',
        workspaceAccess: 'ro',
        scope: 'agent',
      },
      tools: {
        allow: [
          'read', 'web', 'browser',
          'memory_search', 'memory_get',
          'agents_list', 'sessions_send', 'thinking', 'reactions', 'skills', 'write',
        ],
        deny: [...COMMON_DENY, 'exec', 'bash', 'process', 'apply_patch', 'sessions_spawn', 'lobster'],
      },
      memorySearch: {
        sources: ['memory', 'sessions'],
      },
      communication: {
        mode: 'direct',
        canInitiateDirect: true,
        canReceiveDirect: true,
        allowedRoles: ['orchestrator', 'coordinator', 'operator', 'research', 'analyst', 'visual', 'design', 'content'],
      },
      workloadLanes: ['product_conception', 'research'],
      functions: ['product_framing', 'research_synthesis'],
      skills: ['product_taste', 'feature_structuring', 'tradeoff_analysis'],
      abilities: ['recommendation_under_uncertainty', 'grounded_uncertainty'],
      capabilities: ['product', 'mvp', 'gtm', 'feature_spec', 'concept_note', 'agent_communication'],
    },
  },
  {
    type: 'visual-director',
    label: 'Visual Director',
    description: 'Converts rough ideas into strong prompts, art direction, and image revision guidance.',
    emoji: '\ud83c\udfa8',
    modelTier: 'haiku',
    toolCount: 9,
    config: {
      model: {
        primary: 'anthropic/claude-haiku-4-5',
        fallbacks: HAIKU_FALLBACKS,
      },
      identity: {
        name: '',
        theme: 'visual director',
        emoji: '\ud83c\udfa8',
      },
      sandbox: {
        mode: 'all',
        workspaceAccess: 'none',
        scope: 'agent',
      },
      tools: {
        allow: [
          'write', 'edit', 'web',
          'memory_search', 'memory_get',
          'agents_list', 'sessions_send', 'thinking', 'reactions', 'skills',
        ],
        deny: [...COMMON_DENY, 'read', 'apply_patch', 'exec', 'bash', 'process', 'sessions_spawn', 'lobster'],
      },
      memorySearch: {
        sources: ['memory'],
      },
      communication: {
        mode: 'direct',
        canInitiateDirect: true,
        canReceiveDirect: true,
        allowedRoles: ['orchestrator', 'coordinator', 'operator', 'product', 'strategist', 'content'],
      },
      workloadLanes: ['image_prompting'],
      functions: ['image_direction'],
      skills: ['visual_direction', 'prompt_iteration'],
      abilities: ['image_handoff', 'concise_reasoning'],
      capabilities: ['image_prompting', 'art_direction', 'visual_taste', 'hero_image', 'agent_communication'],
    },
  },
]

/** Get a template by type name */
export function getTemplate(type: string): AgentTemplate | undefined {
  return AGENT_TEMPLATES.find(t => t.type === type)
}

/** Build a full OpenClaw agent config from a template + overrides */
export function buildAgentConfig(
  template: AgentTemplate,
  overrides: {
    id: string
    name: string
    workspace?: string
    agentDir?: string
    emoji?: string
    theme?: string
    model?: string
    workspaceAccess?: 'rw' | 'ro' | 'none'
    sandboxMode?: 'all' | 'non-main'
    dockerNetwork?: 'none' | 'bridge'
    subagentAllowAgents?: string[]
  }
): OpenClawAgentConfig {
  const config = structuredClone(template.config)

  config.identity.name = overrides.name
  if (overrides.emoji) config.identity.emoji = overrides.emoji
  if (overrides.theme) config.identity.theme = overrides.theme
  if (overrides.model) config.model.primary = overrides.model
  if (overrides.workspaceAccess) config.sandbox.workspaceAccess = overrides.workspaceAccess
  if (overrides.sandboxMode) config.sandbox.mode = overrides.sandboxMode

  if (overrides.dockerNetwork) {
    config.sandbox.docker = { network: overrides.dockerNetwork }
  }

  if (overrides.subagentAllowAgents && config.subagents) {
    config.subagents.allowAgents = overrides.subagentAllowAgents
  }

  return {
    id: overrides.id,
    name: overrides.name,
    workspace: overrides.workspace,
    agentDir: overrides.agentDir,
    ...config,
  }
}

/** Model tier display info for UI */
export const MODEL_TIERS = {
  opus: { label: 'Opus', color: 'purple', costIndicator: '$$$' },
  sonnet: { label: 'Sonnet', color: 'blue', costIndicator: '$$' },
  haiku: { label: 'Haiku', color: 'green', costIndicator: '$' },
} as const

/** Tool group labels for UI checkboxes */
export const TOOL_GROUP_LABELS = {
  coding: 'Coding (read/write/exec)',
  browser: 'Browser & Web',
  memory: 'Memory Search',
  session: 'Session Management',
  subagent: 'Subagents & LLM Tasks',
  thinking: 'Thinking & Skills',
  readonly: 'Read-only',
} as const
