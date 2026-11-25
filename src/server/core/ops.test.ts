import { beforeEach, describe, expect, it } from 'vitest'
import { Ops, sweepStaleAgents, type Agent, type Goal, type OverlapRow, type Project, type Task } from './ops'
import { Store, OpsError } from './store'
import { FakeTools } from './testing/fake-tools'
import type { GitHubClient } from './github'

let db: FakeTools
let clock: number
const ops = (userId: string, github?: GitHubClient) =>
  new Ops({ store: new Store(db.as(userId)), userId, now: () => clock, github })
const sys = () => new Store(db.as('system'))

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof OpsError && e.code === code)
}

/** A team (alice owner, bob member), a project, a planned goal with tasks. */
async function seed(taskSpecs: Array<{ title: string; files: string[]; deps?: number[] }>, edges: Record<string, string[]> = {}) {
  const alice = ops('alice')
  const { teamId } = await alice.createTeam('Core')
  const { code } = await alice.createInvite(teamId)
  await ops('bob').joinTeam(code)
  const store = sys()
  const projectId = await store.create<Project>('projects', { teamId, repoOwner: 'acme', repoName: 'web', defaultBranch: 'main', kind: 'repo' })
  const goalId = await store.create<Goal>('goals', { teamId, projectId, title: 'Dark mode', status: 'planned', importEdges: edges })
  const ids: string[] = []
  for (const [i, t] of taskSpecs.entries()) {
    ids.push(
      await store.create<Task>('tasks', {
        teamId, projectId, goalId, title: t.title, order: i, status: 'ready',
        predictedFiles: t.files, touchedFiles: [], dependsOn: (t.deps ?? []).map((d) => ids[d]!),
      }),
    )
  }
  return { teamId, projectId, goalId, taskIds: ids }
}

beforeEach(() => {
  db = new FakeTools()
  db.addUser('alice', 'Alice')
  db.addUser('bob', 'Bob')
  db.addUser('eve', 'Eve')
  clock = Date.UTC(2026, 10, 25, 12)
})

describe('teams and invites', () => {
  it('creates a team whose id is its record id and makes the creator owner', async () => {
    const { teamId } = await ops('alice').createTeam('  Core  ')
    const team = db.rows.get(teamId)!
    expect(team.data).toMatchObject({ teamId, name: 'Core', ownerId: 'alice' })
    const members = db.all('team_members')
    expect(members).toHaveLength(1)
    expect(members[0]!.data).toMatchObject({ teamId, userId: 'alice', role: 'owner', status: 'active', userName: 'Alice' })
  })

  it('invite codes are single use and expire', async () => {
    const alice = ops('alice')
    const { teamId } = await alice.createTeam('Core')
    const { code } = await alice.createInvite(teamId)
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
    expect(await ops('bob').joinTeam(code.toLowerCase())).toEqual({ teamId, alreadyMember: false })
    expect(await ops('bob').joinTeam(code)).toEqual({ teamId, alreadyMember: true })
    await expectCode(ops('eve').joinTeam(code), 'invite_used')

    const second = await alice.createInvite(teamId)
    clock += 8 * 24 * 3600 * 1000
    await expectCode(ops('eve').joinTeam(second.code), 'invite_expired')
    await expectCode(ops('eve').joinTeam('NOPE2345'), 'invalid_invite')
  })

  it('outsiders cannot create invites, projects, goals or agents in a team', async () => {
    const { teamId, projectId } = await seed([{ title: 'A', files: ['a.ts'] }])
    const eve = ops('eve')
    await expectCode(eve.createInvite(teamId), 'not_member')
    await expectCode(eve.createProject(teamId, 'acme/other'), 'not_member')
    await expectCode(eve.createGoal(projectId, 'Steal', ''), 'not_found')
    await expectCode(eve.registerAgent(projectId, 'spy'), 'not_found')
  })

  it('rate-limits team creation per user per day', async () => {
    const alice = ops('alice')
    for (let i = 0; i < 20; i++) await alice.createTeam(`T${i}`)
    await expectCode(alice.createTeam("T21"), "rate_limited")
    clock += 24 * 3600 * 1000
    await expect(alice.createTeam('T6')).resolves.toBeTruthy()
  })
})

describe('projects', () => {
  const github = (overrides: Partial<GitHubClient> = {}): GitHubClient => ({
    getRepository: async () => ({ fullName: 'Acme/Web', defaultBranch: 'trunk', description: 'site', isPrivate: false }),
    getTree: async () => ({ paths: [], truncated: false }),
    getReadme: async () => '',
    getFile: async () => null,
    getPullRequest: async () => 'open',
    ...overrides,
  })

  it('checks the repo through GitHub and dedupes by owner/name', async () => {
    const { teamId } = await ops('alice').createTeam('Core')
    const alice = ops('alice', github())
    const first = await alice.createProject(teamId, 'https://github.com/acme/web.git')
    expect(first.existed).toBe(false)
    expect(db.rows.get(first.projectId)!.data).toMatchObject({ repoOwner: 'Acme', repoName: 'Web', defaultBranch: 'trunk' })
    expect(await alice.createProject(teamId, 'ACME/WEB')).toEqual({ projectId: first.projectId, existed: true })
  })

  it('reports missing or private repos clearly', async () => {
    const { teamId } = await ops('alice').createTeam('Core')
    const missing = ops('alice', github({ getRepository: async () => { throw Object.assign(new Error('nf'), { status: 404 }) } }))
    await expectCode(missing.createProject(teamId, 'acme/nope'), 'repo_not_found')
    const priv = ops('alice', github({ getRepository: async () => ({ fullName: 'a/b', defaultBranch: 'main', description: '', isPrivate: true }) }))
    await expectCode(priv.createProject(teamId, 'a/b'), 'repo_private')
    await expectCode(ops('alice', github()).createProject(teamId, 'not a repo'), 'invalid_repo')
  })
})

describe('agent loop', () => {
  it('assigns the least-overlapping ready task and respects dependencies', async () => {
    const { projectId, taskIds } = await seed([
      { title: 'Theme tokens', files: ['src/theme.ts'] },
      { title: 'Toggle', files: ['src/theme.ts', 'src/Toggle.tsx'] },
      { title: 'Docs', files: ['README.md'] },
      { title: 'Wire toggle', files: ['src/App.tsx'], deps: [1] },
    ])
    const alice = ops('alice')
    const bob = ops('bob')
    const a1 = (await alice.registerAgent(projectId, 'claude-1')).agentId
    const b1 = (await bob.registerAgent(projectId, 'codex-1')).agentId

    const first = await alice.nextTask(a1)
    expect(first.task?.taskId).toBe(taskIds[0])
    expect(first.task?.repo).toBe('acme/web')
    // Toggle shares theme.ts with the task in progress, so Docs goes first.
    const second = await bob.nextTask(b1)
    expect(second.task?.taskId).toBe(taskIds[2])
    // Calling again returns the same task rather than claiming another.
    expect((await bob.nextTask(b1)).task?.taskId).toBe(taskIds[2])
    expect(db.rows.get(b1)!.data).toMatchObject({ status: 'working', currentTaskId: taskIds[2] })
  })

  it('never gives one task to two agents, even when both race for it', async () => {
    const { projectId } = await seed([{ title: 'Only task', files: ['a.ts'] }])
    const a1 = (await ops('alice').registerAgent(projectId, 'a1')).agentId
    const b1 = (await ops('bob').registerAgent(projectId, 'b1')).agentId
    const [x, y] = await Promise.all([ops('alice').nextTask(a1), ops('bob').nextTask(b1)])
    const winners = [x, y].filter((r) => r.task)
    expect(winners).toHaveLength(1)
    expect(db.all('task_claims')).toHaveLength(1)
    const loser = [x, y].find((r) => !r.task)!
    expect(loser.message).toMatch(/Nothing to do/)
  })

  it('only the owner of an agent can drive it', async () => {
    const { projectId } = await seed([{ title: 'A', files: ['a.ts'] }])
    const a1 = (await ops('alice').registerAgent(projectId, 'a1')).agentId
    await expectCode(ops('bob').nextTask(a1), 'not_your_agent')
    await expectCode(ops('bob').checkIn(a1, { summary: 'x' }), 'not_your_agent')
    await expectCode(ops('eve').nextTask(a1), 'not_found')
  })

  it('registering the same agent name again reuses the identity', async () => {
    const { projectId } = await seed([{ title: 'A', files: ['a.ts'] }])
    const one = await ops('alice').registerAgent(projectId, 'claude')
    const two = await ops('alice').registerAgent(projectId, 'claude')
    expect(two).toEqual({ agentId: one.agentId, created: false })
    const bobs = await ops('bob').registerAgent(projectId, 'claude')
    expect(bobs.created).toBe(true)
  })

  it('check-ins record files and surface overlaps to both agents', async () => {
    const { projectId, taskIds } = await seed([
      { title: 'Header', files: ['src/Header.tsx'] },
      { title: 'Footer', files: ['src/Footer.tsx'] },
    ])
    const a1 = (await ops('alice').registerAgent(projectId, 'a1')).agentId
    const b1 = (await ops('bob').registerAgent(projectId, 'b1')).agentId
    await ops('alice').nextTask(a1)
    await ops('bob').nextTask(b1)
    expect(db.all('overlaps')).toHaveLength(0)

    const res = await ops('bob').checkIn(b1, { status: 'working', summary: 'Sharing a util', files: ['src/Header.tsx', '/src/util.ts'] })
    expect(res.overlaps).toHaveLength(1)
    expect(res.overlaps[0]).toMatchObject({ kind: 'same-file', files: ['src/Header.tsx'], otherTaskTitle: 'Header', otherAgentName: 'a1' })
    expect(res.message).toMatch(/overlaps/)
    expect(db.rows.get(taskIds[1]!)!.data).toMatchObject({ status: 'in_progress', touchedFiles: ['src/Header.tsx', 'src/util.ts'], lastSummary: 'Sharing a util' })

    const aView = await ops('alice').checkIn(a1, { summary: 'still going' })
    expect(aView.overlaps[0]).toMatchObject({ otherAgentName: 'b1', otherAgentSummary: 'Sharing a util' })

    // A human acknowledges it; finishing one task resolves it.
    const [row] = db.all('overlaps')
    await ops('bob').setOverlapStatus(row!.recordId, 'acknowledged')
    await ops('alice').completeTask(a1, { summary: 'done' })
    expect((db.rows.get(row!.recordId)!.data as unknown as OverlapRow).status).toBe('resolved')
  })

  it('detects import-neighbor overlaps from planner edges', async () => {
    const { projectId } = await seed(
      [{ title: 'Api', files: ['src/api.ts'] }, { title: 'Page', files: ['src/page.ts'] }],
      { 'src/page.ts': ['src/api.ts'] },
    )
    const a1 = (await ops('alice').registerAgent(projectId, 'a1')).agentId
    const b1 = (await ops('bob').registerAgent(projectId, 'b1')).agentId
    await ops('alice').nextTask(a1)
    const second = await ops('bob').nextTask(b1)
    expect(second.overlaps[0]).toMatchObject({ kind: 'import-neighbor' })
    expect(second.message).toMatch(/overlaps/)
  })
})

describe('human steering', () => {
  it('pause, resume and notes take effect at once and are delivered once', async () => {
    const { projectId, taskIds } = await seed([{ title: 'A', files: ['a.ts'] }])
    const a1 = (await ops('alice').registerAgent(projectId, 'a1')).agentId
    await ops('alice').nextTask(a1)

    await ops('bob').sendDirective(a1, 'pause')
    expect(db.rows.get(a1)!.data.status).toBe('paused')
    expect(db.rows.get(taskIds[0]!)!.data.status).toBe('paused')

    const paused = await ops('alice').checkIn(a1, { summary: 'hm' })
    expect(paused.directives).toEqual([{ kind: 'pause', text: '', from: 'Bob' }])
    expect(paused.message).toMatch(/paused/)
    expect(db.rows.get(taskIds[0]!)!.data.status).toBe('paused')
    expect((await ops('alice').nextTask(a1)).task).toBeNull()

    await ops('bob').sendDirective(a1, 'resume')
    await ops('bob').sendDirective(a1, 'note', 'Use CSS variables')
    const resumed = await ops('alice').checkIn(a1, {})
    expect(resumed.directives.map((d) => d.kind)).toEqual(['resume', 'note'])
    expect(resumed.agentStatus).toBe('working')
    expect(db.rows.get(taskIds[0]!)!.data.status).toBe('in_progress')
    expect((await ops('alice').checkIn(a1, {})).directives).toEqual([])
  })

  it('reassign frees the task for another agent', async () => {
    const { projectId, taskIds } = await seed([{ title: 'A', files: ['a.ts'] }])
    const a1 = (await ops('alice').registerAgent(projectId, 'a1')).agentId
    const b1 = (await ops('bob').registerAgent(projectId, 'b1')).agentId
    await ops('alice').nextTask(a1)
    await ops('bob').sendDirective(a1, 'reassign')
    expect(db.rows.get(taskIds[0]!)!.data).toMatchObject({ status: 'ready', agentId: null })
    expect(db.all('task_claims')).toHaveLength(0)
    const told = await ops('alice').checkIn(a1, { summary: 'working' })
    expect(told.message).toMatch(/reassigned/)
    expect((await ops('bob').nextTask(b1)).task?.taskId).toBe(taskIds[0])
  })

  it('outsiders cannot steer agents', async () => {
    const { projectId } = await seed([{ title: 'A', files: ['a.ts'] }])
    const a1 = (await ops('alice').registerAgent(projectId, 'a1')).agentId
    await expectCode(ops('eve').sendDirective(a1, 'pause'), 'not_found')
    await expectCode(ops('bob').sendDirective(a1, 'explode'), 'invalid_input')
  })

  it('questions are answered on the board and reach the agent', async () => {
    const { projectId } = await seed([{ title: 'A', files: ['a.ts'] }])
    const a1 = (await ops('alice').registerAgent(projectId, 'a1')).agentId
    await ops('alice').nextTask(a1)
    const { questionId } = await ops('alice').askHuman(a1, 'Which color for dark mode?')
    await ops('bob').answerQuestion(questionId, '#111')
    await expectCode(ops('bob').answerQuestion(questionId, 'again'), 'already_answered')
    const res = await ops('alice').checkIn(a1, {})
    expect(res.directives[0]).toMatchObject({ kind: 'answer', from: 'Bob' })
    expect(res.directives[0]!.text).toContain('#111')
  })
})

describe('completion', () => {
  it('keeps only PR links in the project repo and closes the goal when all tasks are done', async () => {
    const { projectId, goalId, taskIds } = await seed([
      { title: 'A', files: ['a.ts'] },
      { title: 'B', files: ['b.ts'] },
    ])
    const a1 = (await ops('alice').registerAgent(projectId, 'a1')).agentId
    await ops('alice').nextTask(a1)
    expect(db.rows.get(goalId)!.data.status).toBe('active')
    const bad = await ops('alice').completeTask(a1, { summary: 'did A', prUrl: 'https://github.com/evil/repo/pull/1' })
    expect(bad.prUrl).toBeNull()
    expect(bad.message).toMatch(/ignored/)
    expect(bad.goalDone).toBe(false)

    await ops('alice').nextTask(a1)
    const good = await ops('alice').completeTask(a1, { summary: 'did B', prUrl: 'https://github.com/acme/web/pull/7/files' })
    expect(good.prUrl).toBe('https://github.com/acme/web/pull/7')
    expect(good.goalDone).toBe(true)
    expect(db.rows.get(goalId)!.data.status).toBe('done')
    expect(db.rows.get(taskIds[1]!)!.data).toMatchObject({ status: 'done', prState: 'open' })
    expect(db.rows.get(a1)!.data).toMatchObject({ status: 'idle', currentTaskId: null })
    await expectCode(ops('alice').completeTask(a1, {}), 'no_task')
  })

  it('refreshes PR state at most every 10 minutes per project', async () => {
    const { projectId } = await seed([{ title: 'A', files: ['a.ts'] }])
    const a1 = (await ops('alice').registerAgent(projectId, 'a1')).agentId
    await ops('alice').nextTask(a1)
    await ops('alice').completeTask(a1, { prUrl: 'https://github.com/acme/web/pull/3' })
    let calls = 0
    const gh = { getPullRequest: async () => { calls++; return 'merged' as const } } as unknown as GitHubClient
    expect(await ops('bob', gh).refreshPrs(projectId)).toEqual({ checked: 1, skipped: null })
    expect(db.all('tasks')[0]!.data.prState).toBe('merged')
    expect((await ops('bob', gh).refreshPrs(projectId)).skipped).toBe('throttled')
    clock += 11 * 60 * 1000
    expect((await ops('bob', gh).refreshPrs(projectId)).skipped).toBe('none') // merged PRs aren't re-checked
    expect(calls).toBe(1)
    await expectCode(ops('eve', gh).refreshPrs(projectId), 'not_found')
  })
})

describe('stale sweep', () => {
  it('marks silent real agents offline but leaves demo agents alone', async () => {
    const { projectId } = await seed([{ title: 'A', files: ['a.ts'] }])
    const a1 = (await ops('alice').registerAgent(projectId, 'a1')).agentId
    const d1 = (await ops('alice').registerAgent(projectId, 'demo', 'demo')).agentId
    clock += 20 * 60 * 1000
    expect(await sweepStaleAgents(sys(), clock, 15 * 60 * 1000)).toBe(1)
    expect((db.rows.get(a1)!.data as unknown as Agent).status).toBe('offline')
    expect((db.rows.get(d1)!.data as unknown as Agent).status).toBe('idle')
  })
})
