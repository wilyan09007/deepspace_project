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
import { githubConnection, preferUserGithub, startGithubConnection, userGithub } from '../server/core/github-user'
import { commentPlanOnIssue, goalFromIssue, setMirroring, setupWebhook, syncProject } from '../server/core/github-sync'
import { resetGoalForRetry, runPlanner, type PlannerDeps } from '../server/core/planner'
import { makeOps, userModel } from '../server/core/runtime'
import { seedDevFixture, seedDevRepoProject } from '../server/core/fixtures'
import { exportPlan, loadSample, sampleAvailable } from '../server/core/sample'
import { emailDigestToSelf, generateTodaysDigest } from '../server/core/digest'
import { callIntegration, isCreditError, NO_CREDITS_MESSAGE } from '../server/core/integration'
import { OpsError } from '../server/core/store'

type Ctx = ActionContext<Env>

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function action(fn: (ctx: Ctx) => Promise<unknown>): ActionHandler<Env> {
  return async (ctx) => {
    try {
      return { success: true, data: (await fn(ctx)) ?? {} } as ActionResult
    } catch (e) {
      if (e instanceof OpsError) return { success: false, error: e.message, code: e.code } as ActionResult
      if (isCreditError(e)) return { success: false, error: NO_CREDITS_MESSAGE, code: 'no_credits' } as ActionResult
      console.error(`[action] ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
      return { success: false, error: 'Something went wrong. Please try again.', code: 'internal' } as ActionResult
    }
  }
}

function plannerDeps(ctx: Ctx): PlannerDeps {
  return {
    github: preferUserGithub(userGithub(ctx.env, ctx.callerJwt), githubClient(ctx.env, { kind: 'user', jwt: ctx.callerJwt })),
    generate: userModel(ctx.env, ctx.callerJwt, PLANNER_MODEL),
    modelId: PLANNER_MODEL,
  }
}

const appUrl = (env: Env) => `https://${env.APP_NAME}.app.space`

/** After planning: mirror new tasks as issues (when on) and tell a source issue what it became. Never fails the plan. */
async function afterPlan(ctx: Ctx, goalId: string, projectId: string) {
  const ops = makeOps(ctx.env, ctx.userId, ctx.callerJwt, ctx.callerJwt)
  const gh = userGithub(ctx.env, ctx.callerJwt)
  try {
    const project = await ops.store.get<{ mirrorIssues?: number }>('projects', projectId)
    if (project?.data.mirrorIssues) await syncProject(ops, projectId, gh, appUrl(ctx.env), { force: true })
    await commentPlanOnIssue(ops, goalId, gh, appUrl(ctx.env))
  } catch (e) {
    console.warn(`[github] after-plan sync skipped: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Run the planner; a failure is recorded on the goal, so the UI reads it from there. */
async function plan(ctx: Ctx, goalId: string) {
  const ops = makeOps(ctx.env, ctx.userId, ctx.callerJwt)
  try {
    const { taskIds } = await runPlanner(ops, goalId, plannerDeps(ctx))
    const goal = await ops.store.get<{ projectId: string }>('goals', goalId)
    if (goal) await afterPlan(ctx, goalId, goal.data.projectId)
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

  removeMember: action(({ env, userId, callerJwt, params }) =>
    makeOps(env, userId, undefined, callerJwt).removeMember(str(params.teamId), params.userId).then(() => ({ removed: true })),
  ),

  /** Build (or refresh) today's digest for a team from its activity. Free. */
  generateDigest: action(({ env, userId, callerJwt, params }) =>
    generateTodaysDigest(makeOps(env, userId, undefined, callerJwt), str(params.teamId)),
  ),

  /** Email a digest to the caller's own address, billed to the caller (decision #18). */
  emailDigest: action(async ({ env, userId, callerJwt, params }) => {
    const ops = makeOps(env, userId, undefined, callerJwt)
    return emailDigestToSelf(
      ops,
      str(params.digestId),
      await ops.myEmail(),
      async (msg) => {
        await callIntegration(env, { kind: 'user', jwt: callerJwt }, 'email/send', msg)
      },
      `https://${env.APP_NAME}.app.space`,
    )
  }),

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

  /** Plan a goal from an open GitHub issue on the board, using the text the member reviewed (user-billed, like planGoal). */
  planFromIssue: action(async (ctx) => {
    const ops = makeOps(ctx.env, ctx.userId, ctx.callerJwt, ctx.callerJwt)
    await ops.bump('plan', PLANNER_RUNS_PER_USER_PER_DAY)
    const { goalId } = await goalFromIssue(ops, str(ctx.params.projectId), Number(ctx.params.issueNumber), {
      title: ctx.params.title,
      instructions: ctx.params.body,
    })
    return plan(ctx, goalId)
  }),

  // ── GitHub (decision #19): everything acts as, and is billed to, the caller ──
  githubStatus: action(async ({ env, callerJwt }) => githubConnection(env, callerJwt)),

  connectGithub: action(async ({ env, callerJwt, params }) => {
    const back = typeof params.returnTo === 'string' && params.returnTo.startsWith('/') && !params.returnTo.startsWith('//') ? params.returnTo : '/teams'
    return startGithubConnection(env, callerJwt, `${appUrl(env)}${back}`)
  }),

  setMirroring: action(({ env, userId, callerJwt, params }) =>
    setMirroring(makeOps(env, userId, callerJwt, callerJwt), str(params.projectId), userGithub(env, callerJwt), params.on === true, appUrl(env)),
  ),

  syncGithub: action(({ env, userId, callerJwt, params }) =>
    syncProject(makeOps(env, userId, callerJwt, callerJwt), str(params.projectId), userGithub(env, callerJwt), appUrl(env), { force: params.force === true }),
  ),

  /** Live updates: add a GitHub webhook as the caller, or get the steps to add it by hand (decision #24). */
  setupGithubWebhook: action(({ env, userId, callerJwt, params }) =>
    setupWebhook(makeOps(env, userId, callerJwt, callerJwt), str(params.projectId), userGithub(env, callerJwt), appUrl(env)),
  ),

  // ── Review gate (decision #21) ──
  approveTask: action(({ env, userId, callerJwt, params }) => makeOps(env, userId, undefined, callerJwt).approveTask(str(params.taskId))),

  requestChanges: action(({ env, userId, callerJwt, params }) =>
    makeOps(env, userId, undefined, callerJwt).requestChanges(str(params.taskId), params.note),
  ),

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
    const ops = makeOps(env, userId, undefined, callerJwt)
    if (params.kind === 'repo') return seedDevRepoProject(ops, str(params.teamId))
    return seedDevFixture(ops, str(params.teamId))
  }),
}
