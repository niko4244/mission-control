import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { spawn } from 'child_process'
import { resolve } from 'path'

const ROOT = process.cwd()

// POST /api/virtual-portfolio/trigger-pick
// Manually triggers an immediate pick generation for SportsClaw or TradingDesk.
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const body = await request.json() as { agent?: string }
  const agentName = body.agent || 'SportsClaw'

  if (!['SportsClaw', 'TradingDesk'].includes(agentName)) {
    return NextResponse.json({ ok: false, error: `Unknown agent: ${agentName}` }, { status: 400 })
  }

  const script = resolve(ROOT, 'scripts', 'agent-portfolio-runner.cjs')
  const apiKey = process.env.API_KEY || ''

  return new Promise<NextResponse>((resolve_) => {
    const child = spawn(process.execPath, [script, '--agent', agentName, '--execute'], {
      env: { ...process.env, MC_API_KEY: apiKey, MC_URL: 'http://127.0.0.1:3000' },
      timeout: 240_000,
    })

    let out = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr.on('data', () => {})

    child.on('close', () => {
      try {
        const jsonStart = out.indexOf('{')
        const result = jsonStart >= 0 ? JSON.parse(out.slice(jsonStart)) : {}
        if (result.status === 'PASS' && result.pick) {
          resolve_(NextResponse.json({
            ok: true,
            message: `${agentName} picked: ${result.pick.description} ($${result.pick.amount})`,
            pick: result.pick,
            pick_id: result.submitted_pick_id,
          }))
        } else {
          resolve_(NextResponse.json({
            ok: false,
            error: result.error || 'Pick generation failed',
            details: result,
          }, { status: 422 }))
        }
      } catch {
        resolve_(NextResponse.json({ ok: false, error: 'Failed to parse runner output' }, { status: 500 }))
      }
    })

    child.on('error', (err: Error) => {
      resolve_(NextResponse.json({ ok: false, error: err.message }, { status: 500 }))
    })
  })
}
