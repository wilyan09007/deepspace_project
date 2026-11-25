/**
 * Scheduled tasks (AppCronRoom in worker.ts). Both run as the app owner and
 * make no billed calls:
 * - stale-sweep: marks agents that stopped checking in as offline;
 * - daily-digest: AI-free summary per active team, posted to the team page
 *   (decision #15). Emailing it is a member's own, user-billed action (#18).
 */

import type { CronTask } from 'deepspace/worker'
import type { Env } from '../worker'
import { createActionTools } from './server/action-tools'
import { AGENT_STALE_MS } from './server/core/config'
import { runDailyDigest } from './server/core/digest'
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
    const result = await runDailyDigest(store, now)
    console.info(`[cron] daily-digest wrote ${result.digests} digest(s)`)
  }
}
