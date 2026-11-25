/**
 * Server actions called by the UI (`POST /api/actions/:name`).
 *
 * Each is a thin wrapper over src/server/core/ops.ts, which checks team
 * membership (actions run RBAC-off — see src/server/action-routes.ts).
 * Billed work (GitHub reads, Claude) uses the caller's own JWT only
 * (decision #11); nothing here falls back to the owner's credentials.
 */

import { enqueueJob, type ActionContext, type ActionHandler, type ActionResult } from 'deepspace/worker'
import type { Env } from '../../worker'
import { PLANNER_MODEL, PLANNER_RUNS_PER_USER_PER_DAY } from '../server/core/config'
import { prepareDemo, requestStopDemo } from '../server/core/demo'
import { githubClient } from '../server/core/github'
import { resetGoalForRetry, runPlanner, type PlannerDeps } from '../server/core/planner'
import { makeOps, userModel } from '../server/core/runtime'
import { seedDevFixture } from '../server/core/fixtures'
import { exportPlan, loadSample, sampleAvailable } from '../server/core/sample'
import { OpsError } from '../server/core/store'

type Ctx = ActionContext<Env>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function action(fn: (ctx: Ctx) => Promise<unknown>): ActionHandler<Env> {
  return async (ctx) => {
    try {
      return { success: true, data: (await fn(ctx)) ?? {} } as ActionResult
    } catch (e) {
      if (e instanceof OpsError) return { success: false, error: e.message, code: e.code } as ActionResult
      console.error(`[action] ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
      return { success: false, error: 'Something went wrong. Please try again.', code: 'internal' } as ActionResult
    }
  }
}

function plannerDeps(ctx: Ctx): PlannerDeps {
  return {
    github: githubClient(ctx.env, { kind: 'user', jwt: ctx.callerJwt }),
    generate: userModel(ctx.env, ctx.callerJwt, PLANNER_MODEL),
    modelId: PLANNER_MODEL,
  }
}

/** Run the planner; a failure is recorded on the goal, so the UI reads it from there. */
async function plan(ctx: Ctx, goalId: string) {
  const ops = makeOps(ctx.env, ctx.userId, ctx.callerJwt)
  try {
    const { taskIds } = await runPlanner(ops, goalId, plannerDeps(ctx))
    return { goalId, tasks: taskIds.length }
  } catch (e) {
    if (e instanceof OpsError && (e.code === 'not_found' || e.code === 'not_plannable')) throw e
    return { goalId, failed: true, error: e instanceof Error ? e.message : 'Planning failed' }
  }
}

export const actions: Record<string, ActionHandler<Env>> = {
  createTeam: action(({ env, userId, callerJwt, params }) => makeOps(env, userId, undefined, callerJwt).createTeam(params.name)),

  createInvite: action(({ env, userId, callerJwt, params }) => makeOps(env, userId, undefined, callerJwt).createInvite(str(params.teamId))),

  joinTeam: action(({ env, userId, callerJwt, params }) => makeOps(env, userId, undefined, callerJwt).joinTeam(params.code)),

  setDigestOptIn: action(({ env, userId, callerJwt, params }) =>
    makeOps(env, userId, undefined, callerJwt).setDigestOptIn(str(params.teamId), params.on === true),
  ),

  createProject: action(({ env, userId, callerJwt, params }) =>
    makeOps(env, userId, callerJwt).createProject(str(params.teamId), params.repo),
  ),

  /** Create a goal and plan it in this request (user-billed; progress shows live on the goal). */
  planGoal: action(async (ctx) => {
    const ops = makeOps(ctx.env, ctx.userId, ctx.callerJwt)
    await ops.loadForMember('projects', str(ctx.params.projectId), 'Project')
    await ops.bump('plan', PLANNER_RUNS_PER_USER_PER_DAY)
    const { goalId } = await ops.createGoal(str(ctx.params.projectId), ctx.params.title, ctx.params.body)
    return plan(ctx, goalId)
  }),

  retryPlan: action(async (ctx) => {
    const ops = makeOps(ctx.env, ctx.userId, ctx.callerJwt)
    await ops.bump('plan', PLANNER_RUNS_PER_USER_PER_DAY)
    const goal = await resetGoalForRetry(ops, str(ctx.params.goalId))
    return plan(ctx, goal.recordId)
  }),

  sendDirective: action(({ env, userId, callerJwt, params }) =>
    makeOps(env, userId, undefined, callerJwt).sendDirective(str(params.agentId), params.kind, params.text),
  ),

  answerQuestion: action(({ env, userId, callerJwt, params }) =>
    makeOps(env, userId, undefined, callerJwt).answerQuestion(str(params.questionId), params.answer),
  ),

  setOverlapStatus: action(({ env, userId, callerJwt, params }) =>
    makeOps(env, userId, undefined, callerJwt).setOverlapStatus(str(params.overlapId), params.status),
  ),

  /** Called when a member opens the board; throttled per project (decision #17). */
  refreshPrs: action(({ env, userId, callerJwt, params }) =>
    makeOps(env, userId, callerJwt).refreshPrs(str(params.projectId)),
  ),

  startDemo: action(async ({ env, userId, callerJwt, params }) => {
    const ops = makeOps(env, userId, undefined, callerJwt)
    const payload = await prepareDemo(ops, str(params.projectId))
    const jobId = await enqueueJob(env.JOB_ROOMS, `app:${env.DEEPSPACE_APP_ID}`, 'demo-run', payload, {
      enqueuedBy: userId,
      maxAttempts: 1,
    })
    return { jobId, goalId: payload.goalId }
  }),

  stopDemo: action(({ env, userId, callerJwt, params }) => requestStopDemo(makeOps(env, userId, undefined, callerJwt), str(params.projectId))),

  sampleStatus: action(async () => ({ available: sampleAvailable() })),

  loadSample: action(({ env, userId, callerJwt, params }) => loadSample(makeOps(env, userId, undefined, callerJwt), str(params.teamId))),

  /** A goal's plan as JSON (members only). */
  exportPlan: action(({ env, userId, callerJwt, params }) => exportPlan(makeOps(env, userId, undefined, callerJwt), str(params.goalId))),

  /** Dev/test only: a fixed plan for exercising the board without billing. Refused in production. */
  devSeedFixture: action(async ({ env, userId, callerJwt, params }) => {
    if (env.ALLOW_DEBUG_ROUTES !== 'true') throw new OpsError('not_found', 'Not available', 404)
    return seedDevFixture(makeOps(env, userId, undefined, callerJwt), str(params.teamId))
  }),
}
