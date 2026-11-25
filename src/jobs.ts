/**
 * Background jobs, run by AppJobRoom (worker.ts). Only server code enqueues
 * jobs: the JobRoom refuses client reads and writes (admins excepted), so job
 * payloads never leak between teams. Payloads hold ids only.
 */

import type { Job, JobContext } from 'deepspace/worker'
import type { Env } from '../worker'
import { DEMO_TICK_MS } from './server/core/config'
import { demoTick, finishDemo, initialDemoState, type DemoPayload, type DemoState } from './server/core/demo'
import { makeOps } from './server/core/runtime'
import { OpsError } from './server/core/store'

export async function runJob(job: Job, ctx: JobContext, env: Env): Promise<unknown> {
  switch (job.type) {
    case 'demo-run': {
      const payload = job.payload as DemoPayload
      // Runs as the member who started it; ops re-checks they're still in the team on every step.
      if (!job.enqueuedBy) throw new Error('demo-run needs the starting user')
      const ops = makeOps(env, job.enqueuedBy)
      const state = (job.resumeFrom as DemoState | undefined) ?? initialDemoState()
      try {
        const result = await demoTick(ops, payload, state)
        if (result.done) {
          await finishDemo(ops, payload, result.reason ?? 'finished')
          return { ticks: result.state.tick, reason: result.reason }
        }
        ctx.progress(Math.min(result.state.tick / 80, 0.99), `tick ${result.state.tick}`)
        ctx.continue(result.state, { afterMs: DEMO_TICK_MS })
        return null
      } catch (e) {
        // Lost access, deleted records, … end the run cleanly instead of retrying.
        const reason = e instanceof OpsError ? e.message : 'an error stopped the demo'
        console.error(`[demo-run] ${e instanceof Error ? e.message : String(e)}`)
        await finishDemo(ops, payload, reason).catch(() => {})
        return { ticks: state.tick, reason }
      }
    }
    default:
      throw new Error(`Unknown job type: ${job.type}`)
  }
}
