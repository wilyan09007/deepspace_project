import { beforeEach, describe, expect, it } from 'vitest'
import { demoTick, finishDemo, initialDemoState, prepareDemo, requestStopDemo, type DemoState } from './demo'
import { Ops, type Agent, type Goal, type Project, type Task } from './ops'
import { Store } from './store'
import { FakeTools } from './testing/fake-tools'

let db: FakeTools
const clock = Date.UTC(2026, 10, 25, 12)
const ops = (u: string) => new Ops({ store: new Store(db.as(u)), userId: u, now: () => clock })

async function seed() {
  const alice = ops('alice')
  const { teamId } = await alice.createTeam('Core')
  const { code } = await alice.createInvite(teamId)
  await ops('bob').joinTeam(code)
  const s = new Store(db.as('system'))
  const projectId = await s.create<Project>('projects', { teamId, repoOwner: 'acme', repoName: 'web', defaultBranch: 'main', kind: 'repo' })
  const goalId = await s.create<Goal>('goals', { teamId, projectId, title: 'Dark mode', status: 'planned', importEdges: {} })
  const specs = [['Tokens', ['src/theme.ts']], ['Toggle', ['src/Toggle.tsx']], ['Docs', ['README.md']], ['Wire up', ['src/App.tsx']]] as const
  const ids: string[] = []
  for (const [i, [title, files]] of specs.entries()) {
    ids.push(await s.create<Task>('tasks', { teamId, projectId, goalId, title, order: i, status: 'ready', predictedFiles: [...files], touchedFiles: [], dependsOn: i === 3 ? [ids[1]!] : [] }))
  }
  return { teamId, projectId, goalId }
}

beforeEach(() => {
  db = new FakeTools()
  db.addUser('alice', 'Alice')
  db.addUser('bob', 'Bob')
  db.addUser('eve', 'Eve')
})

describe('demo run', () => {
  it('works every task, makes one overlap and one question, and obeys a pause', async () => {
    const { projectId, goalId } = await seed()
    const payload = await prepareDemo(ops('alice'), projectId)
    expect(payload.agentIds).toHaveLength(3)
    let state: DemoState = initialDemoState()
    let paused = false
    for (let i = 0; i < 80; i++) {
      const r = await demoTick(ops('alice'), payload, state)
      state = r.state
      if (r.done) {
        expect(r.reason).toBe('every task is done')
        break
      }
      if (!paused && db.all('overlaps').length) {
        // A teammate pauses the first demo agent, then resumes it a few ticks later.
        await ops('bob').sendDirective(payload.agentIds[0]!, 'pause')
        paused = true
      }
      if (paused && state.tick === 20) await ops('bob').sendDirective(payload.agentIds[0]!, 'resume')
      const q = db.all('questions').find((r) => r.data.status === 'open')
      if (q && state.tick > 12) await ops('bob').answerQuestion(q.recordId, 'Keep the current behaviour.')
    }
    expect(db.all('tasks').every((t) => t.data.status === 'done')).toBe(true)
    expect(db.all('overlaps').length).toBeGreaterThanOrEqual(1)
    expect(db.all('questions')).toHaveLength(1)
    expect((db.rows.get(goalId)!.data as unknown as Goal).status).toBe('done')
    const kinds = new Set(db.all('directives').map((d) => d.data.kind))
    expect(kinds).toEqual(new Set(['pause', 'resume', 'answer']))
    // Every directive was delivered to the agent.
    expect(db.all('directives').every((d) => d.data.deliveredAt)).toBe(true)
    await finishDemo(ops('alice'), payload, 'every task is done')
    expect(db.all('agents').every((a) => (a.data as unknown as Agent).status === 'offline')).toBe(true)
  })

  it('stops on request and hands held tasks back', async () => {
    const { projectId, goalId } = await seed()
    const payload = await prepareDemo(ops('alice'), projectId)
    let state = initialDemoState()
    for (let i = 0; i < 4; i++) state = (await demoTick(ops('alice'), payload, state)).state
    expect(db.all('task_claims').length).toBeGreaterThan(0)
    await requestStopDemo(ops('bob'), projectId)
    const r = await demoTick(ops('alice'), payload, state)
    expect(r).toMatchObject({ done: true, reason: 'stopped by a teammate' })
    await finishDemo(ops('alice'), payload, r.reason!)
    expect(db.all('task_claims')).toHaveLength(0)
    expect(db.all('tasks').filter((t) => t.data.status !== 'done').every((t) => t.data.status === "ready" && !t.data.agentId)).toBe(true)
    expect((db.rows.get(goalId)!.data as unknown as Goal).demoState).toBe('stopped')
  })

  it('refuses outsiders, double starts, and projects with nothing to do', async () => {
    const { projectId } = await seed()
    await expect(prepareDemo(ops('eve'), projectId)).rejects.toMatchObject({ code: 'not_found' })
    await prepareDemo(ops('alice'), projectId)
    await expect(prepareDemo(ops('bob'), projectId)).rejects.toMatchObject({ code: 'demo_running' })
    for (const t of db.all('tasks')) t.data.status = 'done'
    for (const g of db.all('goals')) g.data.demoState = 'stopped'
    await expect(prepareDemo(ops('alice'), projectId)).rejects.toMatchObject({ code: 'nothing_to_demo' })
  })
})
