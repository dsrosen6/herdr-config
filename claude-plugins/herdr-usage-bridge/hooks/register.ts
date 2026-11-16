import type { Register } from 'claude-code'

// Writes this session's rate-limit windows to ~/.cache/claude-usage/<id>.json,
// read by the Herdr app's `usage` mod: { updatedAt, limits: { <kind>: { percentUsed, resetsAt } } }.
// <id> is the herdr-core terminal (HC_TERMINAL_ID), else this session's id.
export const register: Register = on => {
  on('session.measure', async ($, e, next) => {
    if (e.rateLimits.length > 0 && e.changed.includes('rateLimits')) {
      const home = await $.env.get('HOME')
      const id = (await $.env.get('HC_TERMINAL_ID')) ?? (await $.session.id())
      if (home) {
        const limits: Record<string, { percentUsed: number; resetsAt?: string }> = {}
        for (const w of e.rateLimits) limits[w.kind] = { percentUsed: w.percentUsed, resetsAt: w.resetsAt }
        const file = `${home}/.cache/claude-usage/${id.replace(/[^\w.-]/g, '_')}.json`
        await $.fs.write(file, JSON.stringify({ updatedAt: Date.now(), limits }))
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
