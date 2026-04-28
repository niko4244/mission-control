export type TaskMetadata = Record<string, unknown>

export interface TaskLike {
  title?: string | null
  description?: string | null
  tags?: string[] | string | null
  metadata?: string | TaskMetadata | null
}

export interface TaskImplementationTarget {
  implementation_repo?: string
  code_location?: string
}

export type TaskWorkloadLane =
  | 'lookup'
  | 'coding'
  | 'research'
  | 'product_conception'
  | 'image_prompting'
  | 'tool_routing'
  | 'general'

export interface TaskWorkloadProfile {
  primaryLane: TaskWorkloadLane
  secondaryLanes: TaskWorkloadLane[]
  recommendedAgentRoles: string[]
  recommendedFunctions: string[]
  recommendedSkills: string[]
  recommendedAbilities: string[]
  needsFreshnessCheck: boolean
  needsCodeTools: boolean
  needsImageTool: boolean
  directAnswerPreferred: boolean
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function parseMetadata(metadata: TaskLike['metadata']): TaskMetadata {
  if (!metadata) return {}

  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as TaskMetadata
      }
      return {}
    } catch {
      return {}
    }
  }

  if (typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata
  }

  return {}
}

function parseTags(tags: TaskLike['tags']): string[] {
  if (!tags) return []
  if (Array.isArray(tags)) {
    return tags.filter(isNonEmptyString).map(tag => tag.trim())
  }
  if (typeof tags === 'string') {
    try {
      const parsed = JSON.parse(tags) as unknown
      if (Array.isArray(parsed)) {
        return parsed.filter(isNonEmptyString).map(tag => tag.trim())
      }
    } catch {
      return tags
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean)
    }
  }
  return []
}

const LANE_KEYWORDS: Record<TaskWorkloadLane, string[]> = {
  lookup: [
    'lookup', 'quick comparison', 'quick compare', 'worth trying', 'should i try',
    'consumer pc', 'local model', 'spec', 'newly announced', 'announced', 'quick answer',
  ],
  coding: [
    'code', 'coding', 'bug', 'debug', 'fix', 'feature', 'implementation', 'api',
    'endpoint', 'test', 'repo', 'file', 'refactor', 'cli', 'web app',
  ],
  research: [
    'research', 'brief', 'summarize', 'competing approaches', 'sources',
    'benchmark', 'trend', 'justify switching', 'evaluate', 'analysis',
  ],
  product_conception: [
    'product', 'mvp', 'wedge', 'go-to-market', 'gtm', 'user story',
    'feature spec', 'concept note', 'pain point', 'success criteria',
  ],
  image_prompting: [
    'image', 'hero image', 'illustration', 'visual', 'palette', 'composition',
    'prompt', 'photorealism', 'art direction', 'negative constraints',
  ],
  tool_routing: [
    'what should be handled', 'should be handled', 'search', 'code changes',
    'image tool', 'route', 'routing', 'mixed', 'decides what',
  ],
  general: [],
}

const FRESHNESS_KEYWORDS = [
  'latest', 'newly announced', 'today', 'current', 'recent', 'this week',
  'last 6 months', 'worth trying', 'release details', 'specs',
]

const CODE_TOOL_KEYWORDS = [
  'repo', 'repository', 'codebase', 'file', 'test', 'debug', 'implementation',
  'background job', 'python', 'web app', 'api', 'endpoint',
]

const IMAGE_TOOL_KEYWORDS = [
  'image', 'illustration', 'hero image', 'prompt', 'visual', 'art direction',
]

function buildTaskText(task: TaskLike): string {
  const metadata = parseMetadata(task.metadata)
  const tags = parseTags(task.tags)
  const metadataText = Object.values(metadata)
    .filter(value => typeof value === 'string')
    .join(' ')

  return [
    task.title || '',
    task.description || '',
    tags.join(' '),
    metadataText,
  ]
    .join(' ')
    .toLowerCase()
}

function scoreLane(text: string, lane: TaskWorkloadLane): number {
  return (LANE_KEYWORDS[lane] || []).reduce((score, keyword) => {
    return text.includes(keyword) ? score + 1 : score
  }, 0)
}

export function inferTaskWorkloadProfile(task: TaskLike): TaskWorkloadProfile {
  const text = buildTaskText(task)
  const scoredLanes: TaskWorkloadLane[] = [
    'lookup',
    'coding',
    'research',
    'product_conception',
    'image_prompting',
    'tool_routing',
  ]
  const laneScores: Array<{ lane: TaskWorkloadLane; score: number }> = scoredLanes.map(lane => ({
    lane,
    score: scoreLane(text, lane),
  }))

  laneScores.sort((a, b) => b.score - a.score)

  const primaryLane = laneScores[0]?.score > 0 ? laneScores[0].lane : 'general'
  const secondaryLanes = laneScores
    .slice(1)
    .filter(entry => entry.score > 0)
    .map(entry => entry.lane)

  const mixedTask = secondaryLanes.length > 0
  const needsFreshnessCheck = FRESHNESS_KEYWORDS.some(keyword => text.includes(keyword))
  const needsCodeTools =
    primaryLane === 'coding' ||
    secondaryLanes.includes('coding') ||
    CODE_TOOL_KEYWORDS.some(keyword => text.includes(keyword))
  const needsImageTool =
    primaryLane === 'image_prompting' ||
    secondaryLanes.includes('image_prompting') ||
    IMAGE_TOOL_KEYWORDS.some(keyword => text.includes(keyword))

  const recommendedAgentRoles = Array.from(new Set([
    ...(mixedTask || primaryLane === 'tool_routing' ? ['orchestrator'] : []),
    ...(primaryLane === 'coding' ? ['developer', 'specialist-dev'] : []),
    ...(primaryLane === 'lookup' || primaryLane === 'research' ? ['researcher'] : []),
    ...(primaryLane === 'product_conception' ? ['strategist', 'content-creator'] : []),
    ...(primaryLane === 'image_prompting' ? ['content-creator'] : []),
    ...(primaryLane === 'general' ? ['assistant', 'orchestrator'] : []),
  ]))

  const recommendedFunctions = Array.from(new Set([
    ...(needsFreshnessCheck ? ['search'] : ['direct_answer']),
    ...(needsCodeTools ? ['code_execution'] : []),
    ...(primaryLane === 'research' ? ['research_synthesis'] : []),
    ...(primaryLane === 'product_conception' ? ['product_framing'] : []),
    ...(needsImageTool ? ['image_direction'] : []),
    ...(mixedTask || primaryLane === 'tool_routing' ? ['tool_routing'] : []),
  ]))

  const recommendedSkills = Array.from(new Set([
    ...(primaryLane === 'lookup' ? ['concise_factual_answering', 'comparison'] : []),
    ...(primaryLane === 'coding' ? ['debugging', 'implementation_planning'] : []),
    ...(primaryLane === 'research' ? ['source_grounded_synthesis', 'tradeoff_analysis'] : []),
    ...(primaryLane === 'product_conception' ? ['product_taste', 'feature_structuring'] : []),
    ...(primaryLane === 'image_prompting' ? ['visual_direction', 'prompt_iteration'] : []),
    ...(mixedTask || primaryLane === 'tool_routing' ? ['task_decomposition', 'routing'] : []),
  ]))

  const recommendedAbilities = Array.from(new Set([
    ...(needsFreshnessCheck ? ['freshness_awareness'] : []),
    ...(needsCodeTools ? ['code_tool_use'] : []),
    ...(needsImageTool ? ['image_handoff'] : []),
    ...(primaryLane === 'product_conception' ? ['recommendation_under_uncertainty'] : []),
    ...(mixedTask || primaryLane === 'tool_routing' ? ['tool_selection'] : []),
    'grounded_uncertainty',
    'concise_reasoning',
  ]))

  return {
    primaryLane,
    secondaryLanes,
    recommendedAgentRoles,
    recommendedFunctions,
    recommendedSkills,
    recommendedAbilities,
    needsFreshnessCheck,
    needsCodeTools,
    needsImageTool,
    directAnswerPreferred: !needsFreshnessCheck && !needsCodeTools && !needsImageTool,
  }
}

export function resolveTaskImplementationTarget(task: TaskLike): TaskImplementationTarget {
  const metadata = parseMetadata(task.metadata)

  const implementationRepoCandidates = [
    metadata.implementation_repo,
    metadata.implementationRepo,
    metadata.github_repo,
  ]

  const codeLocationCandidates = [
    metadata.code_location,
    metadata.codeLocation,
    metadata.path,
  ]

  const implementation_repo = implementationRepoCandidates.find(isNonEmptyString)
  const code_location = codeLocationCandidates.find(isNonEmptyString)

  return {
    ...(implementation_repo ? { implementation_repo } : {}),
    ...(code_location ? { code_location } : {}),
  }
}
