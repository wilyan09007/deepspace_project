/**
 * Scheduled tasks (AppCronRoom in worker.ts). Both run as the app owner and
 * make no billed calls:
 * - stale-sweep: marks agents that stopped checking in as offline, and gives
 *   back tasks held by agents silent for 2+ hours (auto-release);
 * - daily-digest: AI-free summary per active team, posted to the team page
 *   (decision #15). Emailing it is a member's own, user-billed action (#18).
 */

import type { CronTask } from 'deepspace/worker'
import type { Env } from '../worker'
import { createActionTools } from './server/action-tools'
import { AGENT_RELEASE_MS, AGENT_STALE_MS } from './server/core/config'
import { runDailyDigest } from './server/core/digest'
import { sweepStaleAgents } from './server/core/ops'
import { makeOps } from './server/core/runtime'
import { Store } from './server/core/store'

export const tasks: CronTask[] = [
  { name: 'stale-sweep', intervalMinutes: 5 },
  { name: 'daily-digest', schedule: '0 22 * * *', timezone: 'UTC' },
]

export async function runTask(name: string, env: Env): Promise<void> {
  const store = new Store(createActionTools(env, env.OWNER_USER_ID, ''))
  const now = Date.now()
  if (name === 'stale-sweep') {
    const { offline, released } = await sweepStaleAgents(makeOps(env, env.OWNER_USER_ID), now, AGENT_STALE_MS, AGENT_RELEASE_MS)
    if (offline || released) console.info(`[cron] stale-sweep: ${offline} agent(s) offline, ${released} task(s) released`)
    return
  }
  if (name === 'daily-digest') {
    const result = await runDailyDigest(store, now)
    console.info(`[cron] daily-digest wrote ${result.digests} digest(s)`)
  }
}
