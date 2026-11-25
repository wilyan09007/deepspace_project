import { beforeEach, describe, expect, it } from 'vitest'
import { Ops, type Goal, type Task } from './ops'
import { exportPlan, loadSample, sampleAvailable } from './sample'
import { SAMPLE_PLAN } from './sample-plan'
import { Store } from './store'
import { FakeTools } from './testing/fake-tools'

let db: FakeTools
const ops = (u: string) => new Ops({ store: new Store(db.as(u)), userId: u, now: () => Date.UTC(2026, 10, 25) })

beforeEach(() => {
  db = new FakeTools()
  db.addUser('alice', 'Alice')
  db.addUser('eve', 'Eve')
})

describe('sample', () => {
  it('is a captured real plan', () => {
    expect(sampleAvailable()).toBe(true)
    expect(SAMPLE_PLAN!.model).toMatch(/^claude-/)
    expect(SAMPLE_PLAN!.tasks.length).toBeGreaterThanOrEqual(3)
    SAMPLE_PLAN!.tasks.forEach((t, i) => t.dependsOn.forEach((d) => expect(d).toBeLessThan(i)))
  })

  it('loads once per team, round-trips through exportPlan, and refuses outsiders', async () => {
    const { teamId } = await ops('alice').createTeam('Core')
    const first = await loadSample(ops('alice'), teamId)
    const tasks = db.all('tasks').map((t) => t.data as unknown as Task)
    expect(tasks).toHaveLength(SAMPLE_PLAN!.tasks.length)
    expect((db.rows.get(first.goalId)!.data as unknown as Goal)).toMatchObject({ status: 'planned', source: 'sample' })
    expect(await loadSample(ops('alice'), teamId)).toEqual(first)

    const exported = await exportPlan(ops('alice'), first.goalId)
    expect(exported.tasks.map((t) => [t.title, t.dependsOn])).toEqual(SAMPLE_PLAN!.tasks.map((t) => [t.title, t.dependsOn]))
    await expect(loadSample(ops('eve'), teamId)).rejects.toMatchObject({ code: 'not_member' })
    await expect(exportPlan(ops('eve'), first.goalId)).rejects.toMatchObject({ code: 'not_found' })
  })
})
