/**
 * Scheduled tasks (AppCronRoom in worker.ts). Both run as the app owner:
 * - stale-sweep: marks agents that stopped checking in as offline (no billed calls);
 * - daily-digest: AI-free summary per active team; the only owner-paid cost is
 *   the opt-in digest email, capped per day (decisions #15, #16).
 */

import type { CronTask } from 'deepspace/worker'
import type { Env } from '../worker'
import { createActionTools } from './server/action-tools'
import { AGENT_STALE_MS } from './server/core/config'
import { runDailyDigest } from './server/core/digest'
import { callIntegration } from './server/core/integration'
import { sweepStaleAgents } from './server/core/ops'
import { Store } from './server/core/store'

export const tasks: CronTask[] = [
  { name: 'stale-sweep', intervalMinutes: 5 },
  { name: 'daily-digest', schedule: '0 22 * * *', timezone: 'UTC' },
]

export async function runTask(name: string, env: Env): Promise<void> {
  const store = new Store(createActionTools(env, env.OWNER_USER_ID, ''))
  const now = Date.now()
  if (name === 'stale-sweep') {
    const marked = await sweepStaleAgents(store, now, AGENT_STALE_MS)
    if (marked) console.info(`[cron] stale-sweep marked ${marked} agent(s) offline`)
    return
  }
  if (name === 'daily-digest') {
    const appUrl = `https://${env.APP_NAME}.app.space`
    const result = await runDailyDigest(store, now, async (msg) => {
      // Owner-paid by necessity (no user is signed in during cron) — capped in runDailyDigest.
      await callIntegration(env, { kind: 'owner' }, 'email/send', {
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      })
    }, appUrl)
    console.info(`[cron] daily-digest wrote ${result.digests} digest(s), sent ${result.emails} email(s)`)
  }
}
