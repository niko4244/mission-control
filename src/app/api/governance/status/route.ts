import { NextRequest, NextResponse } from 'next/server'
import path from 'node:path'
import fs from 'node:fs'

const ROOT = path.resolve(process.cwd())

function loadScript(scriptPath: string) {
  const absolute = path.join(ROOT, scriptPath)
  if (!fs.existsSync(absolute)) return null
  try {
    return require(absolute)
  } catch {
    return null
  }
}

export async function GET(_request: NextRequest) {
  try {
    const botSystem = loadScript('scripts/mission-control-bot-system.cjs') as {
      buildStatusMode: (rootDir: string) => Record<string, unknown>
    } | null

    const releaseGov = loadScript('scripts/release-governor.cjs') as {
      runReleaseGovernor: (options: Record<string, unknown>) => Record<string, unknown>
    } | null

    const botSystemResult = botSystem
      ? botSystem.buildStatusMode(ROOT)
      : { status: 'WARN', registry: { implemented: [], planned: [] } }

    const releaseResult = releaseGov
      ? releaseGov.runReleaseGovernor({ rootDir: ROOT })
      : { status: 'WARN', branch: '', working_tree_clean: false }

    const registry = (botSystemResult.registry as Record<string, unknown>) ?? {}
    const implemented = Array.isArray(registry.implemented) ? registry.implemented as string[] : []
    const planned = Array.isArray(registry.planned) ? registry.planned as string[] : []
    const hierarchyWarnings = Array.isArray(botSystemResult.warnings) ? botSystemResult.warnings as string[] : []
    const blockingConditions = Array.isArray(botSystemResult.blocking_conditions) ? botSystemResult.blocking_conditions as string[] : []

    const releaseRec = releaseResult as Record<string, unknown>
    const overallStatus =
      blockingConditions.length > 0 || releaseRec.status === 'FAIL' ? 'FAIL'
        : hierarchyWarnings.length > 0 || releaseRec.status === 'WARN' ? 'WARN'
          : 'PASS'

    return NextResponse.json({
      agent: 'Governance Status API v1',
      status: overallStatus,
      timestamp: new Date().toISOString(),
      bot_registry: {
        implemented_count: implemented.length,
        planned_count: planned.length,
        implemented,
        planned,
        hierarchy_warnings: hierarchyWarnings,
        blocking_conditions: blockingConditions,
      },
      release_governor: {
        status: releaseRec.status,
        branch: releaseRec.branch,
        working_tree_clean: releaseRec.working_tree_clean,
        warnings: Array.isArray(releaseRec.warnings) ? releaseRec.warnings : [],
        blockers: Array.isArray(releaseRec.blockers) ? releaseRec.blockers : [],
      },
      summary: {
        observe_only: true,
        governance_healthy: overallStatus === 'PASS',
        pending_bot_count: planned.length,
      },
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown error'
    return NextResponse.json({
      agent: 'Governance Status API v1',
      status: 'FAIL',
      timestamp: new Date().toISOString(),
      error: { message },
    }, { status: 500 })
  }
}
