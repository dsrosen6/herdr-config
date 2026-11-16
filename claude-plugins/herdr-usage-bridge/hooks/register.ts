import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

// One JSON file per Herdr terminal, read by the Herdr app's `usage` mod:
// ~/.cache/claude-usage/<HC_TERMINAL_ID>.json. Every rate-limit window Claude
// Code reports is kept by its kind (five_hour, seven_day, and any other).
// Outside Herdr it does nothing.

type Win = { percentUsed: number; resetsAt?: string }
type Snapshot = { terminal: string; limits: Record<string, Win>; updatedAt: number }

let file: string | null | undefined
let snap: Snapshot | null = null

async function locate($: EngineInterface): Promise<string | null> {
  if (file !== undefined) return file
  try {
    const r = await $.process.run(['sh', '-c', 'printf "%s\\n%s" "$HOME" "$HC_TERMINAL_ID"'], { timeoutMs: 5000 })
    const [home, terminal] = r.stdout.split('\n')
    if (!home || !terminal) return (file = null)
    const dir = `${home}/.cache/claude-usage`
    await $.process.run(['mkdir', '-p', dir], { timeoutMs: 5000 })
    snap = { terminal, limits: {}, updatedAt: 0 }
    file = `${dir}/${terminal}.json`
  } catch {
    file = null
  }
  return file
}

async function publish($: EngineInterface, limits: SessionRateLimit[]) {
  const path = await locate($)
  if (!path || !snap || limits.length === 0) return
  const next = { ...snap.limits }
  for (const l of limits) next[l.kind] = { percentUsed: l.percentUsed, resetsAt: l.resetsAt }
  snap = { ...snap, limits: next, updatedAt: await $.clock.now() }
  try {
    await $.fs.write(path, JSON.stringify(snap))
  } catch {}
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      await publish($, (await $.session.usage()).rateLimits)
    } catch {}
    return result
  })

  on('session.measure', async ($, e, next) => {
    await publish($, e.rateLimits)
    return next(e)
  })
}
