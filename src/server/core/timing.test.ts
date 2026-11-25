/**
 * Every time-based rule in Conductor, proven in seconds with a fake clock.
 * Each test calls the same function production uses; only the clock moves.
 *
 *   npx vitest run src/server/core/timing.test.ts
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { ToolSet } from 'ai'
import { buildAssistantTools, hourKey, PROPOSAL_TTL_MS } from '../../ai/assistant'
import { AGENT_STALE_MS, ASSISTANT_MESSAGES_PER_HOUR, DEMO_MAX_TICKS, INVITE_TTL_MS, PR_REFRESH_MIN_GAP_MS } from './config'
import { demoTick, initialDemoState, prepareDemo } from './demo'
import { buildTeamDigest } from './digest'
import type { GitHubClient } from './github'
import { Ops, sweepStaleAgents, type Agent, type Goal, type Project, type Task } from './ops'
import { resetGoalForRetry, STALE_PLANNING_MS } from './planner'
import { Store } from './store'
import { FakeTools } from './testing/fake-tools'

const MIN = 60_000
let db: FakeTools
let clock: number
const ops = (u: string, github?: GitHubClient) => new Ops({ store: new Store(db.as(u)), userId: u, now: () => clock, github })
const sys = () => new Store(db.as('system'))

async function projectWithTask() {
  const { teamId } = await ops('alice').createTeam('Core')
  const projectId = await sys().create<Project>('projects', { teamId, repoOwner: 'acme', repoName: 'web', defaultBranch: 'main', kind: 'repo' })
  const goalId = await sys().create<Goal>('goals', { teamId, projectId, title: 'G', status: 'planned', importEdges: {} })
  await sys().create<Task>('tasks', { teamId, projectId, goalId, title: 'T', order: 0, status: 'ready', predictedFiles: ['a.ts'], touchedFiles: [], dependsOn: [] })
  return { teamId, projectId, goalId }
}

beforeEach(() => {
  db = new FakeTools()
  for (const u of ['alice', 'bob']) db.addUser(u, u)
  clock = Date.UTC(2026, 10, 25, 1, 0) // 5:00 PM Pacific
})

describe('timing rules', () => {
  it(`stale sweep: an agent is marked offline only after ${AGENT_STALE_MS / MIN} silent minutes`, async () => {
    const { projectId } = await projectWithTask()
    const { agentId } = await ops('alice').registerAgent(projectId, 'claude')
    clock += AGENT_STALE_MS - MIN
    expect(await sweepStaleAgents(sys(), clock, AGENT_STALE_MS)).toBe(0)
    clock += 2 * MIN
    expect(await sweepStaleAgents(sys(), clock, AGENT_STALE_MS)).toBe(1)
    expect((db.rows.get(agentId)!.data as unknown as Agent).status).toBe('offline')
    // Checking in again brings it back.
    await ops('alice').checkIn(agentId, { summary: 'back' })
    expect((db.rows.get(agentId)!.data as unknown as Agent).status).not.toBe('offline')
  })

  it('invite links expire after 7 days', async () => {
    const { teamId } = await ops('alice').createTeam('Core')
    const { code, expiresAt } = await ops('alice').createInvite(teamId)
    expect(expiresAt - clock).toBe(INVITE_TTL_MS)
    clock = expiresAt + 1
    await expect(ops('bob').joinTeam(code)).rejects.toMatchObject({ code: 'invite_expired' })
  })

  it(`PR status refresh runs at most once per ${PR_REFRESH_MIN_GAP_MS / MIN} minutes per project`, async () => {
    const { projectId } = await projectWithTask()
    const { agentId } = await ops('alice').registerAgent(projectId, 'claude')
    await ops('alice').nextTask(agentId)
    await ops('alice').completeTask(agentId, { prUrl: 'https://github.com/acme/web/pull/1' })
    const gh = { getPullRequest: async () => 'open' as const } as unknown as GitHubClient
    expect((await ops('alice', gh).refreshPrs(projectId)).skipped).toBeNull()
    clock += PR_REFRESH_MIN_GAP_MS - MIN
    expect((await ops('alice', gh).refreshPrs(projectId)).skipped).toBe('throttled')
    clock += 2 * MIN
    expect((await ops('alice', gh).refreshPrs(projectId)).skipped).toBeNull()
  })

  it(`assistant: ${ASSISTANT_MESSAGES_PER_HOUR} messages per clock hour, reset on the hour`, async () => {
    clock = Date.UTC(2026, 10, 25, 1, 40) // 5:40 PM Pacific
    const alice = ops('alice')
    for (let i = 0; i < ASSISTANT_MESSAGES_PER_HOUR; i++) await alice.bump('assistant', ASSISTANT_MESSAGES_PER_HOUR, hourKey(clock))
    await expect(alice.bump('assistant', ASSISTANT_MESSAGES_PER_HOUR, hourKey(clock))).rejects.toMatchObject({ code: 'rate_limited' })
    clock = Date.UTC(2026, 10, 25, 2, 0) // 6:00 PM Pacific
    await expect(alice.bump('assistant', ASSISTANT_MESSAGES_PER_HOUR, hourKey(clock))).resolves.toBe(1)
  })

  it(`assistant: a proposed pause expires after ${PROPOSAL_TTL_MS / MIN} minutes`, async () => {
    const { projectId } = await projectWithTask()
    const { agentId } = await ops('alice').registerAgent(projectId, 'claude')
    const send = (msg: string) =>
      (buildAssistantTools(ops('alice'), msg) as ToolSet & Record<string, { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }>)
        .send_directive!.execute({ agent_id: agentId, kind: 'pause' }, { toolCallId: 't', messages: [] })
    await send('pause claude')
    clock += PROPOSAL_TTL_MS - MIN
    expect((await send('yes')).done).toBe(true)
    await ops('alice').sendDirective(agentId, 'resume')
    await send('pause claude')
    clock += PROPOSAL_TTL_MS + MIN
    expect((await send('yes')).done).toBe(false)
  })

  it(`a goal stuck "planning" can be retried after ${STALE_PLANNING_MS / MIN} minutes, not before`, async () => {
    const { projectId } = await projectWithTask()
    const { goalId } = await ops('alice').createGoal(projectId, 'Stuck goal', '')
    // The fake store stamps updatedAt from its own clock; pin it to "now" for this goal.
    db.rows.get(goalId)!.updatedAt = new Date(clock).toISOString()
    clock += STALE_PLANNING_MS - MIN
    await expect(resetGoalForRetry(ops('alice'), goalId)).rejects.toMatchObject({ code: 'not_retryable' })
    clock += 2 * MIN
    await expect(resetGoalForRetry(ops('alice'), goalId)).resolves.toBeTruthy()
  })

  it('daily limits reset at the next UTC day (4 PM Pacific)', async () => {
    const alice = ops('alice')
    for (let i = 0; i < 20; i++) await alice.createTeam(`T${i}`)
    await expect(alice.createTeam('one more')).rejects.toMatchObject({ code: 'rate_limited' })
    clock = Date.UTC(2026, 10, 26, 0, 0) // 4:00 PM Pacific the next day
    await expect(alice.createTeam('one more')).resolves.toBeTruthy()
  })

  it("a day's digest covers only that day's activity", async () => {
    const { teamId } = await ops('alice').createTeam('Core')
    clock += 24 * 60 * MIN
    expect(await buildTeamDigest(sys(), teamId, 'Core', '2026-11-26')).toBeNull()
    await ops('alice').createInvite(teamId)
    const { code } = await ops('alice').createInvite(teamId)
    await ops('bob').joinTeam(code)
    const id = await buildTeamDigest(sys(), teamId, 'Core', '2026-11-26')
    expect(db.rows.get(id!)!.data.body).toContain('joined the team')
    expect(db.rows.get(id!)!.data.body).not.toContain('created the team')
  })

  it(`the demo stops itself after ${DEMO_MAX_TICKS} ticks`, async () => {
    const { projectId } = await projectWithTask()
    const payload = await prepareDemo(ops('alice'), projectId)
    const r = await demoTick(ops('alice'), payload, { ...initialDemoState(), tick: DEMO_MAX_TICKS })
    expect(r).toMatchObject({ done: true, reason: 'time limit reached' })
  })
})
