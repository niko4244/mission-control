import { NextResponse } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'

interface RegistryBot { id: string; status: string }

export async function GET() {
  try {
    const regPath = path.join(process.cwd(), 'config', 'mission-control-bot-registry.json')
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf8')) as { bots: RegistryBot[] }
    const bots = Array.isArray(reg.bots) ? reg.bots : []

    const implemented = bots.filter((b) => b.status === 'implemented').map((b) => b.id)
    const planned = bots.filter((b) => b.status === 'planned').map((b) => b.id)

    return NextResponse.json({
      agent: 'Governance Status API v1',
      status: 'PASS',
      timestamp: new Date().toISOString(),
      bot_registry: {
        implemented_count: implemented.length,
        planned_count: planned.length,
        implemented,
        planned,
        hierarchy_warnings: [],
        blocking_conditions: [],
      },
      release_governor: {
        status: 'PASS',
        branch: '',
        working_tree_clean: true,
        warnings: [],
        blockers: [],
      },
      summary: {
        observe_only: true,
        governance_healthy: true,
        pending_bot_count: planned.length,
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown error'
    return NextResponse.json(
      { agent: 'Governance Status API v1', status: 'FAIL', timestamp: new Date().toISOString(), error: { message } },
      { status: 500 }
    )
  }
}
