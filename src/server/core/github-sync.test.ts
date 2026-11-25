import { beforeEach, describe, expect, it } from 'vitest'
import { GithubNotConnected, type GitHubWriter, type IssueSummary, type PullSummary } from './github-user'
import {
  commentPlanOnIssue,
  goalFromIssue,
  issueBody,
  parsePrLinks,
  parseTaskMarker,
  setMirroring,
  syncProject,
  type GithubItem,
} from './github-sync'
import { Ops, type Goal, type Project, type Task } from './ops'
import { Store } from './store'
import { FakeTools } from './testing/fake-tools'

/** A tiny in-memory GitHub repo. */
class FakeGitHub implements GitHubWriter {
  issues: Array<IssueSummary & { comments: string[] }> = []
  pulls: PullSummary[] = []
  labels = new Set<string>()
  calls: string[] = []
  perm: 'admin' | 'write' | 'read' | 'none' = 'write'
  connected = true
  private check() {
    if (!this.connected) throw new GithubNotConnected()
  }
  async permission() { this.check(); return this.perm }
  async ensureLabel(_o: string, _r: string, name: string) { this.check(); this.labels.add(name) }
  async createIssue(_o: string, _r: string, i: { title: string; body: string; labels: string[] }) {
    this.check()
    this.calls.push('create')
    const number = this.issues.length + this.pulls.length + 1
    this.issues.push({ number, title: i.title, body: i.body, labels: i.labels, url: `https://github.com/acme/web/issues/${number}`, state: 'open', author: 'alice-gh', updatedAt: `t${number}`, comments: [] })
    return { number, url: `https://github.com/acme/web/issues/${number}` }
  }
  async updateIssue(_o: string, _r: string, n: number, p: { body?: string; labels?: string[]; state?: 'open' | 'closed' }) {
    this.check()
    this.calls.push(`update ${n}`)
    const i = this.issues.find((x) => x.number === n)!
    Object.assign(i, { ...(p.body ? { body: p.body } : {}), ...(p.labels ? { labels: p.labels } : {}), ...(p.state ? { state: p.state } : {}), updatedAt: `u${this.calls.length}` })
  }
  async comment(_o: string, _r: string, n: number, body: string) { this.check(); this.issues.find((x) => x.number === n)!.comments.push(body) }
  async listIssues() { this.check(); return this.issues.map((i) => ({ ...i })) }
  async listPulls() { this.check(); return this.pulls.map((p) => ({ ...p })) }
}

let db: FakeTools
let gh: FakeGitHub
let clock: number
const APP = 'https://squadboard.app.space'
const ops = (u: string) => new Ops({ store: new Store(db.as(u)), userId: u, now: () => clock })

async function seed() {
  const { teamId } = await ops('alice').createTeam('Core')
  await ops('bob').joinTeam((await ops('alice').createInvite(teamId)).code)
  const s = new Store(db.as('system'))
  const projectId = await s.create<Project>('projects', { teamId, repoOwner: 'acme', repoName: 'web', defaultBranch: 'main', kind: 'repo' })
  const goalId = await s.create<Goal>('goals', { teamId, projectId, title: 'Dark mode', status: 'planned', importEdges: {} })
  const ids: string[] = []
  for (const [i, [title, files]] of ([['Theme', ['src/theme.ts']], ['Toggle', ['src/Toggle.tsx']], ['Wire', ['src/App.tsx']]] as const).entries()) {
    ids.push(await s.create<Task>('tasks', { teamId, projectId, goalId, title, body: `Do ${title}`, acceptance: 'works', order: i, status: 'ready', predictedFiles: [...files], touchedFiles: [], dependsOn: i === 2 ? [ids[0]!] : [] }))
  }
  return { teamId, projectId, goalId, taskIds: ids }
}

beforeEach(() => {
  db = new FakeTools()
  for (const u of ['alice', 'bob', 'eve']) db.addUser(u, u)
  gh = new FakeGitHub()
  clock = Date.UTC(2026, 10, 25, 2)
})

describe('GitHub formats', () => {
  it('writes a footer Squadboard can read back', () => {
    const body = issueBody('tas_7', { teamId: 't', projectId: 'p', goalId: 'g', title: 'X', body: 'Do X', acceptance: 'X works', predictedFiles: ['a.ts'], order: 0, status: 'in_progress' }, { goalTitle: 'Goal', dependsOnIssues: [3], sourceIssue: 1, appUrl: APP })
    expect(body).toContain('**Done when:** X works')
    expect(body).toContain('**Depends on:** #3')
    expect(body).toContain('**Goal:** Goal (from #1)')
    expect(body).toContain('Squadboard status: In progress')
    expect(body).toContain(`${APP}/t/t/p/p?task=tas_7`)
    expect(parseTaskMarker(body)).toBe('tas_7')
    expect(parseTaskMarker('no marker')).toBeNull()
  })

  it('reads task links from a PR description', () => {
    expect(parsePrLinks('Adds the toggle.\n\nCloses #12, fixes #3\nSquadboard-Task: tas_9')).toEqual({ taskIds: ['tas_9'], closes: [12, 3] })
    expect(parsePrLinks('resolves #4 and Resolved #5')).toEqual({ taskIds: [], closes: [4, 5] })
    expect(parsePrLinks('Mentions #8 only')).toEqual({ taskIds: [], closes: [] })
    // Written under the app's old name (Conductor): still understood.
    expect(parsePrLinks('Conductor-Task: tas_1')).toEqual({ taskIds: ['tas_1'], closes: [] })
    expect(parseTaskMarker('<!-- conductor:task=tas_2 -->')).toBe('tas_2')
  })
})

describe('mirroring', () => {
  it('needs a connected GitHub account with write access', async () => {
    const { projectId } = await seed()
    gh.connected = false
    await expect(setMirroring(ops('alice'), projectId, gh, true, APP)).rejects.toMatchObject({ code: 'github_not_connected' })
    gh.connected = true
    gh.perm = 'read'
    await expect(setMirroring(ops('alice'), projectId, gh, true, APP)).rejects.toMatchObject({ code: 'no_push_access' })
    await expect(setMirroring(ops('eve'), projectId, gh, true, APP)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('creates one labelled issue per task, then keeps status, labels and state in step', async () => {
    const { projectId, taskIds } = await seed()
    const r = await setMirroring(ops('alice'), projectId, gh, true, APP)
    expect(r).toMatchObject({ created: 3 })
    expect(gh.labels).toContain('squadboard: review')
    expect(gh.issues.map((i) => [i.title, i.labels])).toEqual([
      ['Theme', ['squadboard', 'squadboard: ready']],
      ['Toggle', ['squadboard', 'squadboard: ready']],
      ['Wire', ['squadboard', 'squadboard: ready']],
    ])
    expect(gh.issues[2]!.body).toContain('**Depends on:** #1')
    expect(db.rows.get(taskIds[0]!)!.data).toMatchObject({ issueNumber: 1, ghStatus: 'ready' })

    // An agent takes Theme; a human added their own label on GitHub meanwhile.
    const a1 = (await ops('alice').registerAgent(projectId, 'a1')).agentId
    const next = await ops('alice').nextTask(a1)
    expect(next.task?.issue).toEqual({ number: 1, url: 'https://github.com/acme/web/issues/1' })
    expect(next.task?.prInstructions).toContain('Closes #1')
    gh.issues[0]!.labels.push('frontend')
    clock += 3 * 60_000
    expect(await syncProject(ops('alice'), projectId, gh, APP)).toMatchObject({ created: 0, updated: 1 })
    expect(gh.issues[0]!.labels).toEqual(['frontend', 'squadboard', 'squadboard: in progress'])
    expect(gh.issues[0]!.body).toContain('Squadboard status: In progress')

    // Nothing changed → no GitHub writes; and syncs within 2 minutes are skipped.
    gh.calls = []
    clock += 3 * 60_000
    await syncProject(ops('alice'), projectId, gh, APP)
    expect(gh.calls).toEqual([])
    expect(await syncProject(ops('alice'), projectId, gh, APP)).toMatchObject({ skipped: 'throttled' })
  })
})

describe('reading GitHub back', () => {
  it('links PRs by Closes #N or Squadboard-Task, approves on merge, and alerts overlapping agents', async () => {
    const { projectId, taskIds } = await seed()
    await setMirroring(ops('alice'), projectId, gh, true, APP)
    const a1 = (await ops('alice').registerAgent(projectId, 'a1')).agentId
    const b1 = (await ops('bob').registerAgent(projectId, 'b1')).agentId
    await ops('alice').nextTask(a1) // Theme (#1)
    await ops('bob').nextTask(b1) // Toggle (#2)
    await ops('bob').checkIn(b1, { files: ['src/theme.ts'] })
    await ops('alice').completeTask(a1, { summary: 'done' })

    gh.pulls.push({ number: 10, title: 'Theme tokens', body: 'Closes #1', url: 'https://github.com/acme/web/pull/10', state: 'open', merged: false, labels: [], author: 'alice-gh', updatedAt: 'p1' })
    gh.pulls.push({ number: 11, title: 'Toggle', body: 'wip\nSquadboard-Task: ' + taskIds[1], url: 'https://github.com/acme/web/pull/11', state: 'open', merged: false, labels: [], author: 'bob-gh', updatedAt: 'p2' })
    gh.pulls.push({ number: 12, title: 'Unrelated', body: 'typo', url: 'https://github.com/acme/web/pull/12', state: 'open', merged: false, labels: [], author: 'carol', updatedAt: 'p3' })
    clock += 3 * 60_000
    const r = await syncProject(ops('bob'), projectId, gh, APP)
    expect(r).toMatchObject({ linkedPrs: 2, openPrs: 3 })
    expect(db.rows.get(taskIds[0]!)!.data).toMatchObject({ prUrl: 'https://github.com/acme/web/pull/10', prState: 'open', status: 'review' })
    expect(db.rows.get(taskIds[1]!)!.data).toMatchObject({ prUrl: 'https://github.com/acme/web/pull/11' })
    const items = db.all('github_items').map((i) => i.data as unknown as GithubItem)
    expect(items.find((i) => i.kind === 'pr' && i.number === 12)!.linkedTaskId).toBe('')
    expect(items.find((i) => i.kind === 'pr' && i.number === 10)!.linkedTaskId).toBe(taskIds[0])

    // PR #10 merges → Theme done, issue #1 closed on the next push, Bob's agent told to rebase.
    gh.pulls[0]!.merged = true
    gh.pulls[0]!.state = 'closed'
    clock += 3 * 60_000
    await syncProject(ops('bob'), projectId, gh, APP)
    expect(db.rows.get(taskIds[0]!)!.data.status).toBe('done')
    expect(gh.issues[0]!.state).toBe('closed')
    expect(gh.issues[0]!.labels).toContain('squadboard: done')
    const notes = (await ops('bob').checkIn(b1, {})).directives
    expect(notes.some((d) => d.text.includes('was merged') && d.text.includes('src/theme.ts'))).toBe(true)
    // Merged/closed PRs drop off the open list.
    expect(db.all('github_items').some((i) => (i.data as unknown as GithubItem).number === 10)).toBe(false)
  })

  it('closing a mirrored issue on GitHub finishes the task', async () => {
    const { projectId, taskIds } = await seed()
    await setMirroring(ops('alice'), projectId, gh, true, APP)
    gh.issues[1]!.state = 'closed'
    gh.issues[1]!.author = 'carol'
    clock += 3 * 60_000
    expect(await syncProject(ops('alice'), projectId, gh, APP)).toMatchObject({ doneFromGithub: 1 })
    expect(db.rows.get(taskIds[1]!)!.data.status).toBe('done')
  })

  it("ignores a task marker copied onto an issue Squadboard didn't create", async () => {
    const { projectId, taskIds } = await seed()
    await setMirroring(ops('alice'), projectId, gh, true, APP)
    // Anyone can open an issue on a public repo, paste the marker from a mirrored issue, and close it.
    const copy = (number: number, from: number, state: 'open' | 'closed') =>
      gh.issues.push({ number, title: 'copy', body: gh.issues[from]!.body, url: `https://github.com/acme/web/issues/${number}`, state, labels: [], author: 'mallory', updatedAt: `m${number}`, comments: [] })
    copy(50, 1, 'closed')
    copy(51, 0, 'open')
    clock += 3 * 60_000
    expect(await syncProject(ops('alice'), projectId, gh, APP)).toMatchObject({ doneFromGithub: 0 })
    expect(db.rows.get(taskIds[1]!)!.data).toMatchObject({ status: 'ready', issueNumber: 2 })
    // The copy is listed as an ordinary open issue, not as the task's.
    const items = db.all('github_items').map((i) => i.data as unknown as GithubItem)
    expect(items.find((i) => i.number === 51)!.linkedTaskId).toBe('')
    expect(items.find((i) => i.number === 1)!.linkedTaskId).toBe(taskIds[0])
  })

  it('links a task that has no issue yet only to an issue carrying the Squadboard label', async () => {
    const { projectId, taskIds } = await seed()
    const tagged = (number: number, taskId: string, state: 'open' | 'closed', labels: string[], author: string) =>
      gh.issues.push({ number, title: 't', body: `<!-- squadboard:task=${taskId} -->`, url: `https://github.com/acme/web/issues/${number}`, state, labels, author, updatedAt: `t${number}`, comments: [] })
    // An outsider's issue: no label (only people with access to the repo can set labels).
    tagged(60, taskIds[0]!, 'closed', [], 'mallory')
    // One Squadboard created whose number never got saved: it carries Squadboard's labels.
    tagged(61, taskIds[1]!, 'open', ['squadboard', 'squadboard: ready'], 'alice-gh')
    await syncProject(ops('alice'), projectId, gh, APP, { force: true })
    expect(db.rows.get(taskIds[0]!)!.data.issueNumber).toBeUndefined()
    expect(db.rows.get(taskIds[0]!)!.data.status).not.toBe('done')
    expect(db.rows.get(taskIds[1]!)!.data.issueNumber).toBe(61)
  })

  it('turns an open issue into a goal and reports the plan back on the issue', async () => {
    const { projectId } = await seed()
    gh.issues.push({ number: 40, title: 'Add search', body: 'Users want search.', url: 'https://github.com/acme/web/issues/40', state: 'open', labels: [], author: 'dana', updatedAt: 'x', comments: [] })
    await syncProject(ops('alice'), projectId, gh, APP, { force: true })
    // The member reviews (and here edits) the issue text before it becomes instructions for agents.
    const reviewed = { title: 'Search', instructions: 'Add a search box to the header that filters projects by name.' }
    const { goalId } = await goalFromIssue(ops('alice'), projectId, 40, reviewed)
    expect(db.rows.get(goalId)!.data).toMatchObject({ title: 'Search', body: reviewed.instructions, sourceIssueNumber: 40, status: 'planning' })
    // Never falls back to the issue's own text: no reviewed instructions, no goal.
    await expect(goalFromIssue(ops('alice'), projectId, 40, { title: 'Search', instructions: '' })).rejects.toMatchObject({ code: 'invalid_input' })
    // (planner runs here in the real flow) — fake two planned tasks:
    const s = new Store(db.as('system'))
    const goal = db.rows.get(goalId)!.data as unknown as Goal
    await s.create<Task>('tasks', { teamId: goal.teamId, projectId, goalId, title: 'Search API', order: 0, status: 'ready', issueNumber: 41 })
    await s.create<Task>('tasks', { teamId: goal.teamId, projectId, goalId, title: 'Search box', order: 1, status: 'ready' })
    await commentPlanOnIssue(ops('alice'), goalId, gh, APP)
    expect(gh.issues.find((i) => i.number === 40)!.comments[0]).toContain('- #41 Search API')
    await expect(goalFromIssue(ops('alice'), projectId, 999, reviewed)).rejects.toMatchObject({ code: 'not_found' })
  })
})
