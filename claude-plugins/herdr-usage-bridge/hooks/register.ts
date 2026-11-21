import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

// One JSON file per Herdr terminal, read by the Herdr app's `usage` mod:
// ~/.cache/claude-usage/<HC_TERMINAL_ID>.json. Every rate-limit window Claude
// Code reports is kept by its kind (five_hour, seven_day, and any other), and
// `context` is this session's live context window (tokens, window, percent),
// so the mod can show the focused agent's fill. Outside Herdr it does nothing.

type Win = { percentUsed: number; resetsAt?: string }
type Ctx = { tokens?: number; window: number; percent?: number }
type Snapshot = { terminal: string; limits: Record<string, Win>; context?: Ctx; updatedAt: number }

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

async function publish($: EngineInterface, limits: SessionRateLimit[], context: SessionContextUsage) {
  const path = await locate($)
  if (!path || !snap) return
  const next = { ...snap.limits }
  for (const l of limits) next[l.kind] = { percentUsed: l.percentUsed, resetsAt: l.resetsAt }
  const ctx: Ctx = { tokens: context.tokens, window: context.window, percent: context.percent }
  snap = { ...snap, limits: next, context: ctx, updatedAt: await $.clock.now() }
  try {
    await $.fs.write(path, JSON.stringify(snap))
  } catch {}
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    try {
      const u = await $.session.usage()
      await publish($, u.rateLimits, u.context)
    } catch {}
    return result
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('context') || e.changed.includes('rateLimits')) await publish($, e.rateLimits, e.context)
    return next(e)
  })
}
