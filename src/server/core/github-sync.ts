/**
 * Two-way GitHub sync for a project (decision #19).
 *
 * Out: each task is mirrored as an issue — labelled `conductor` plus its
 * status, with a footer Squadboard reads back — and closed when the task is
 * done. In: open issues and PRs are listed on the board; PRs are linked to
 * tasks by `Squadboard-Task: <id>` or `Closes #<issue>`; a merged PR approves
 * its task (and triggers merge alerts); closing a mirrored issue on GitHub
 * marks the task done.
 *
 * Everything runs as the member who triggered it, through their own GitHub
 * connection, billed to them (decision #22). Nothing here runs on a schedule.
 */

import { GITHUB_SYNC_MIN_GAP_MS } from './config'
import type { GitHubWriter, IssueSummary, PullSummary } from './github-user'
import { GithubNotConnected } from './github-user'
import { clip, randomSecret, type Goal, type Ops, type Project, type Task, type TaskStatus } from './ops'
import { OpsError, type Row } from './store'

export const STATUS_TEXT: Record<TaskStatus, string> = {
  ready: 'Ready',
  assigned: 'In progress',
  in_progress: 'In progress',
  blocked: 'Blocked',
  paused: 'Paused',
  review: 'Review',
  done: 'Done',
}
export const BASE_LABEL = 'squadboard'
/** Label/marker prefixes this app has used (it was called Conductor before). */
const OUR_LABEL_PREFIXES = ['squadboard', 'conductor']
export const statusLabel = (s: TaskStatus) => `squadboard: ${STATUS_TEXT[s].toLowerCase()}`
const LABELS: Array<[string, string, string]> = [
  [BASE_LABEL, 'f2b134', 'Managed by Squadboard'],
  ['squadboard: ready', 'c5cfdb', 'Squadboard: waiting for an agent'],
  ['squadboard: in progress', '3fc7c0', 'Squadboard: an agent is working on it'],
  ['squadboard: blocked', 'f06464', 'Squadboard: blocked'],
  ['squadboard: paused', 'f2b134', 'Squadboard: paused by a teammate'],
  ['squadboard: review', 'a78bfa', 'Squadboard: waiting for human review'],
  ['squadboard: done', '4ade80', 'Squadboard: done'],
]

// ── Formats (written to GitHub, read back) ─────────────────────────────────

// Reads markers written under the old name too.
const MARKER = /<!--\s*(?:squadboard|conductor):task=([A-Za-z0-9_-]+)\s*-->/

export function boardUrl(appUrl: string, task: Pick<Task, 'teamId' | 'projectId'>, taskId: string): string {
  return `${appUrl}/t/${task.teamId}/p/${task.projectId}?task=${encodeURIComponent(taskId)}`
}

/** Issue body for a task. The footer's last lines are what Squadboard reads back. */
export function issueBody(
  taskId: string,
  task: Task,
  ctx: { goalTitle?: string; dependsOnIssues: number[]; sourceIssue?: number; appUrl: string },
): string {
  const lines: string[] = []
  if (task.body) lines.push(task.body, '')
  if (task.acceptance) lines.push(`**Done when:** ${task.acceptance}`)
  if (task.predictedFiles?.length) lines.push(`**Likely files:** ${task.predictedFiles.map((f) => `\`${f}\``).join(', ')}`)
  if (ctx.dependsOnIssues.length) lines.push(`**Depends on:** ${ctx.dependsOnIssues.map((n) => `#${n}`).join(', ')}`)
  if (ctx.goalTitle) lines.push(`**Goal:** ${ctx.goalTitle}${ctx.sourceIssue ? ` (from #${ctx.sourceIssue})` : ''}`)
  lines.push(
    '',
    '---',
    `Squadboard status: ${STATUS_TEXT[task.status]}`,
    `[Open in Squadboard](${boardUrl(ctx.appUrl, task, taskId)}) · PRs for this task should include \`Closes #<this issue>\` and \`Squadboard-Task: ${taskId}\``,
    `<!-- squadboard:task=${taskId} -->`,
  )
  return lines.join('\n')
}

export function parseTaskMarker(body: string): string | null {
  return body.match(MARKER)?.[1] ?? null
}

/** Task ids and issue numbers a PR description links to. */
export function parsePrLinks(body: string): { taskIds: string[]; closes: number[] } {
  const taskIds = [...body.matchAll(/(?:Squadboard|Conductor)-Task:\s*([A-Za-z0-9_-]+)/gi)].map((m) => m[1]!)
  const closes = [...body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map((m) => Number(m[1]))
  return { taskIds: [...new Set(taskIds)], closes: [...new Set(closes)] }
}

// ── Sync ───────────────────────────────────────────────────────────────────

export interface GithubItem {
  teamId: string
  projectId: string
  key: string
  kind: 'issue' | 'pr'
  number: number
  title: string
  url: string
  state: string
  author: string
  linkedTaskId: string
  merged: number
  updatedAtGh: string
  body: string
}

export interface SyncResult {
  skipped?: 'throttled'
  created: number
  updated: number
  linkedPrs: number
  doneFromGithub: number
  openIssues: number
  openPrs: number
}

function notConnected(e: unknown): never {
  if (e instanceof GithubNotConnected) throw new OpsError('github_not_connected', 'Connect your GitHub account first (board → GitHub → Connect).', 412)
  throw e
}

export async function setMirroring(ops: Ops, projectId: string, gh: GitHubWriter, on: boolean, appUrl: string): Promise<SyncResult | { mirrorIssues: false }> {
  const project = await ops.loadForMember<Project>('projects', projectId, 'Project')
  if (project.data.kind !== 'repo') throw new OpsError('not_a_repo', 'Only projects added from a GitHub repo can sync')
  if (!on) {
    await ops.store.update<Project>('projects', projectId, { mirrorIssues: 0 })
    await ops.log({ teamId: project.data.teamId, projectId, kind: 'github', message: 'turned off GitHub issue mirroring' })
    return { mirrorIssues: false }
  }
  const { repoOwner: owner, repoName: repo } = project.data
  const perm = await gh.permission(owner, repo).catch(notConnected)
  if (perm !== 'admin' && perm !== 'write') {
    throw new OpsError('no_push_access', `Your GitHub account can't write to ${owner}/${repo}, so Squadboard can't create issues there as you.`, 403)
  }
  for (const [name, color, description] of LABELS) await gh.ensureLabel(owner, repo, name, color, description)
  await ops.store.update<Project>('projects', projectId, { mirrorIssues: 1, mirrorBy: await ops.userName() })
  await ops.log({ teamId: project.data.teamId, projectId, kind: 'github', message: `turned on GitHub issue mirroring for ${owner}/${repo}` })
  return syncProject(ops, projectId, gh, appUrl, { force: true })
}

export async function syncProject(ops: Ops, projectId: string, gh: GitHubWriter, appUrl: string, opts: { force?: boolean } = {}): Promise<SyncResult> {
  const project = await ops.loadForMember<Project>('projects', projectId, 'Project')
  const result: SyncResult = { created: 0, updated: 0, linkedPrs: 0, doneFromGithub: 0, openIssues: 0, openPrs: 0 }
  if (project.data.kind !== 'repo') throw new OpsError('not_a_repo', 'Only projects added from a GitHub repo can sync')
  if (!opts.force && ops.now() - (project.data.ghSyncedAt ?? 0) < GITHUB_SYNC_MIN_GAP_MS) return { ...result, skipped: 'throttled' }
  await ops.store.update<Project>('projects', projectId, { ghSyncedAt: ops.now() })
  const { teamId, repoOwner: owner, repoName: repo } = project.data

  try {
    const [issues, pulls] = await Promise.all([gh.listIssues(owner, repo), gh.listPulls(owner, repo)]).catch(notConnected)
    const index = await taskIndex(ops, projectId)
    const { byId, byIssue } = index

    // In: issues closed on GitHub finish their task.
    for (const issue of issues) if (await readIssue(ops, index, issue)) result.doneFromGithub++

    // In: PRs that name a task (or close its issue) are linked; merged ones approve it.
    const prLinks = new Map<string, string>()
    for (const pr of pulls) {
      const { linked, newLinks } = await readPull(ops, index, pr)
      for (const taskId of linked) prLinks.set(`${pr.number}`, taskId)
      result.linkedPrs += newLinks
    }

    // Out: mirror tasks as issues and push status changes.
    if (project.data.mirrorIssues) {
      const goals = new Map((await ops.store.query<Goal>('goals', { projectId })).map((g) => [g.recordId, g]))
      const issueLabels = new Map(issues.map((i) => [i.number, i.labels]))
      const ordered = [...byId.values()].sort((a, b) => a.data.goalId.localeCompare(b.data.goalId) || a.data.order - b.data.order)
      for (const task of ordered) {
        const goal = goals.get(task.data.goalId)
        if (!goal || goal.data.status === 'failed') continue
        const ctx = {
          goalTitle: goal.data.title,
          sourceIssue: goal.data.sourceIssueNumber,
          dependsOnIssues: (task.data.dependsOn ?? []).map((d) => byId.get(d)?.data.issueNumber).filter((n): n is number => !!n),
          appUrl,
        }
        if (!task.data.issueNumber) {
          if (task.data.status === 'done') continue
          const created = await gh.createIssue(owner, repo, {
            title: task.data.title,
            body: issueBody(task.recordId, task.data, ctx),
            labels: [BASE_LABEL, statusLabel(task.data.status)],
          })
          await ops.store.update<Task>('tasks', task.recordId, { issueNumber: created.number, issueUrl: created.url, ghStatus: task.data.status })
          task.data.issueNumber = created.number
          byIssue.set(created.number, task)
          result.created++
          continue
        }
        if (task.data.ghStatus === task.data.status) continue
        const others = (issueLabels.get(task.data.issueNumber) ?? []).filter((l) => !OUR_LABEL_PREFIXES.some((p) => l.startsWith(p)))
        await gh.updateIssue(owner, repo, task.data.issueNumber, {
          body: issueBody(task.recordId, task.data, ctx),
          labels: [...others, BASE_LABEL, statusLabel(task.data.status)],
          state: task.data.status === 'done' ? 'closed' : 'open',
          ...(task.data.status === 'done' ? { state_reason: 'completed' } : {}),
        })
        await ops.store.update<Task>('tasks', task.recordId, { ghStatus: task.data.status })
        result.updated++
      }
      if (result.created) {
        await ops.log({ teamId, projectId, kind: 'github', message: `created ${result.created} GitHub issue(s) for tasks` })
      }
    }

    // The board's GitHub panel: open issues and PRs.
    const openIssues = issues.filter((i) => i.state === 'open').slice(0, 50)
    const openPrs = pulls.filter((p) => p.state === 'open').slice(0, 50)
    result.openIssues = openIssues.length
    result.openPrs = openPrs.length
    await replaceItems(ops, project, [
      ...openIssues.map((i) => item(project, 'issue', i, byIssue.get(i.number)?.recordId ?? '')),
      ...openPrs.map((p) => item(project, 'pr', p, prLinks.get(`${p.number}`) ?? '')),
    ])
    await ops.store.update<Project>('projects', projectId, { ghSyncError: '' })
    return result
  } catch (e) {
    const message = e instanceof OpsError ? e.message : `GitHub sync failed: ${clip(e instanceof Error ? e.message : String(e), 200)}`
    await ops.store.update<Project>('projects', projectId, { ghSyncError: message })
    throw e instanceof OpsError ? e : new OpsError('github_sync_failed', message, 502)
  }
}

/** A project's tasks by id and by GitHub issue number, for reading GitHub back (sync and webhooks). */
export interface TaskIndex {
  byId: Map<string, Row<Task>>
  byIssue: Map<number, Row<Task>>
}

export async function taskIndex(ops: Ops, projectId: string): Promise<TaskIndex> {
  const tasks = await ops.projectTasks(projectId)
  return {
    byId: new Map(tasks.map((t) => [t.recordId, t])),
    byIssue: new Map(tasks.filter((t) => t.data.issueNumber).map((t) => [t.data.issueNumber!, t])),
  }
}

/** Read one issue back: link a task to its own issue, and finish the task once the issue is closed. True if it finished one. */
export async function readIssue(ops: Ops, index: TaskIndex, issue: IssueSummary): Promise<boolean> {
  const taskId = parseTaskMarker(issue.body)
  const task = taskId ? index.byId.get(taskId) : undefined
  if (!task || !isTasksIssue(task, issue)) return false
  if (!task.data.issueNumber) {
    await ops.store.update<Task>('tasks', task.recordId, { issueNumber: issue.number, issueUrl: issue.url })
    task.data.issueNumber = issue.number
    index.byIssue.set(issue.number, task)
  }
  if (issue.state !== 'closed' || task.data.status === 'done') return false
  await ops.markDone(task, issue.author || 'GitHub', `closed #${issue.number} on GitHub, so “${task.data.title}” is done`)
  task.data.status = 'done'
  return true
}

/** Read one PR back: link the tasks it names (Squadboard-Task: <id>, or Closes #<their issue>); a merged PR approves them. */
export async function readPull(ops: Ops, index: TaskIndex, pr: PullSummary): Promise<{ linked: string[]; newLinks: number }> {
  const { taskIds, closes } = parsePrLinks(pr.body)
  const linked = [...new Set([...taskIds.filter((id) => index.byId.has(id)), ...closes.map((n) => index.byIssue.get(n)?.recordId).filter((x): x is string => !!x)])]
  let newLinks = 0
  for (const taskId of linked) {
    const task = index.byId.get(taskId)!
    const state = pr.merged ? 'merged' : pr.state
    if (task.data.prUrl !== pr.url || task.data.prState !== state) {
      const firstLink = task.data.prUrl !== pr.url
      await ops.store.update<Task>('tasks', taskId, { prUrl: pr.url, prState: state })
      task.data.prUrl = pr.url
      task.data.prState = state
      if (firstLink) {
        newLinks++
        await ops.log({ teamId: task.data.teamId, projectId: task.data.projectId, taskId, kind: 'github', message: `linked PR #${pr.number} to “${task.data.title}”`, actorName: pr.author || 'GitHub' })
      }
    }
    if (pr.merged) {
      await ops.applyPrMerged(task)
      task.data.status = 'done'
    }
  }
  return { linked, newLinks }
}

/** Keep the board's GitHub list in step with one issue or PR (from a webhook): listed while open, dropped once closed. */
export async function refreshItem(ops: Ops, project: Row<Project>, kind: 'issue' | 'pr', i: IssueSummary | PullSummary, linkedTaskId: string): Promise<void> {
  const [row] = await ops.store.query<GithubItem>('github_items', { key: `${project.recordId}:${kind}:${i.number}` })
  if (i.state !== 'open') {
    if (row) await ops.store.remove('github_items', row.recordId)
    return
  }
  const fresh = item(project, kind, i, linkedTaskId)
  if (row) await ops.store.update<GithubItem>('github_items', row.recordId, fresh)
  else await ops.store.tryCreate<GithubItem>('github_items', fresh)
}

/** A project's GitHub webhook: the secret GitHub signs deliveries with (server-only), and the hook's id once added. */
export interface WebhookRow {
  teamId: string
  projectId: string
  secret: string
  hookId: number
  createdAt: number
}

export const webhookUrl = (appUrl: string, projectId: string) => `${appUrl}/api/github/webhook/${projectId}`

export type WebhookSetup = { mode: 'auto'; url: string } | { mode: 'manual'; url: string; secret: string; reason: string }

/**
 * Have GitHub push issue and PR events to Squadboard as they happen, instead of waiting for someone to
 * open the board. Adds the webhook as the member; GitHub only lets repo admins do that, so otherwise
 * returns what an admin pastes into the repo's Settings → Webhooks. The signing secret is kept in a
 * server-only collection and only ever shown to a member setting the webhook up by hand.
 */
export async function setupWebhook(ops: Ops, projectId: string, gh: GitHubWriter, appUrl: string): Promise<WebhookSetup> {
  const project = await ops.loadForMember<Project>('projects', projectId, 'Project')
  if (project.data.kind !== 'repo') throw new OpsError('not_a_repo', 'Only projects added from a GitHub repo can sync')
  const { teamId, repoOwner: owner, repoName: repo } = project.data
  const url = webhookUrl(appUrl, projectId)
  let [row] = await ops.store.query<WebhookRow>('github_webhooks', { projectId })
  // Already live (added by Squadboard, or by hand and receiving events): never show the secret again.
  if (row?.data.hookId || project.data.ghWebhookAt) return { mode: 'auto', url }
  if (!row) {
    await ops.store.tryCreate<WebhookRow>('github_webhooks', { teamId, projectId, secret: randomSecret(), hookId: 0, createdAt: ops.now() })
    ;[row] = await ops.store.query<WebhookRow>('github_webhooks', { projectId })
    if (!row) throw new OpsError('webhook_failed', 'Could not prepare the webhook. Try again.', 500)
  }
  try {
    const { id } = await gh.createWebhook(owner, repo, { url, secret: row.data.secret, events: ['issues', 'pull_request'] })
    await ops.store.update<WebhookRow>('github_webhooks', row.recordId, { hookId: id })
    await ops.store.update<Project>('projects', projectId, { ghWebhook: 'auto' })
    await ops.log({ teamId, projectId, kind: 'github', message: `turned on live GitHub updates for ${owner}/${repo}` })
    return { mode: 'auto', url }
  } catch (e) {
    if (e instanceof GithubNotConnected) notConnected(e)
    await ops.store.update<Project>('projects', projectId, { ghWebhook: 'manual' })
    return { mode: 'manual', url, secret: row.data.secret, reason: `Squadboard couldn't add the webhook as you: GitHub only lets admins of ${owner}/${repo} do that.` }
  }
}

/**
 * Whether an issue carrying a task's marker really is that task's issue. Anyone can paste a marker
 * into an issue on a public repo, so the marker alone proves nothing: a task only answers to the
 * issue it saved, and a task with none saved only links to an issue with Squadboard's label
 * (GitHub lets only people with access to the repo set labels).
 */
function isTasksIssue(task: Row<Task>, issue: IssueSummary): boolean {
  if (task.data.issueNumber) return task.data.issueNumber === issue.number
  return issue.labels.some((l) => OUR_LABEL_PREFIXES.some((p) => l.startsWith(p)))
}

function item(project: Row<Project>, kind: 'issue' | 'pr', i: IssueSummary | PullSummary, linkedTaskId: string): GithubItem {
  return {
    teamId: project.data.teamId,
    projectId: project.recordId,
    key: `${project.recordId}:${kind}:${i.number}`,
    kind,
    number: i.number,
    title: clip(i.title, 200),
    url: i.url,
    state: i.state,
    author: i.author,
    linkedTaskId,
    merged: 'merged' in i && i.merged ? 1 : 0,
    updatedAtGh: i.updatedAt,
    body: clip(i.body.replace(MARKER, ''), 4000),
  }
}

async function replaceItems(ops: Ops, project: Row<Project>, items: GithubItem[]): Promise<void> {
  const existing = await ops.store.query<GithubItem>('github_items', { projectId: project.recordId })
  const byKey = new Map(existing.map((r) => [r.data.key, r]))
  for (const it of items) {
    const row = byKey.get(it.key)
    if (!row) await ops.store.tryCreate<GithubItem>('github_items', it)
    else if (row.data.updatedAtGh !== it.updatedAtGh || row.data.linkedTaskId !== it.linkedTaskId || row.data.state !== it.state) {
      await ops.store.update<GithubItem>('github_items', row.recordId, it)
    }
    byKey.delete(it.key)
  }
  for (const stale of byKey.values()) await ops.store.remove('github_items', stale.recordId)
}

/**
 * Create a goal from an open GitHub issue on the board (the caller then plans it). Anyone can open an
 * issue on a public repo, so the issue's text never goes to the planner or agents as-is: the board
 * pre-fills the New goal dialog with it, and `reviewed` is what the member read, edited and submitted.
 */
export async function goalFromIssue(
  ops: Ops,
  projectId: string,
  issueNumber: number,
  reviewed: { title: unknown; instructions: unknown },
): Promise<{ goalId: string; issue: GithubItem }> {
  const project = await ops.loadForMember<Project>('projects', projectId, 'Project')
  const [row] = await ops.store.query<GithubItem>('github_items', { key: `${project.recordId}:issue:${issueNumber}` })
  if (!row) throw new OpsError('not_found', `Issue #${issueNumber} isn't in the synced list — click Sync first`, 404)
  const issue = row.data
  const { goalId } = await ops.createGoal(projectId, reviewed.title, reviewed.instructions)
  await ops.store.update<Goal>('goals', goalId, { sourceIssueNumber: issue.number, sourceIssueUrl: issue.url })
  return { goalId, issue }
}

/** After planning a goal from an issue: tell the issue which tasks it became (needs mirroring for #links). */
export async function commentPlanOnIssue(ops: Ops, goalId: string, gh: GitHubWriter, appUrl: string): Promise<void> {
  const goal = await ops.loadForMember<Goal>('goals', goalId, 'Goal')
  if (!goal.data.sourceIssueNumber) return
  const project = await ops.loadForMember<Project>('projects', goal.data.projectId, 'Project')
  const tasks = (await ops.store.query<Task>('tasks', { goalId })).sort((a, b) => a.data.order - b.data.order)
  if (!tasks.length) return
  const lines = tasks.map((t) => `- ${t.data.issueNumber ? `#${t.data.issueNumber} ` : ''}${t.data.title}`)
  const link = `${appUrl}/t/${project.data.teamId}/p/${project.recordId}`
  await gh.comment(
    project.data.repoOwner,
    project.data.repoName,
    goal.data.sourceIssueNumber,
    [`Squadboard planned this into ${tasks.length} task(s):`, '', ...lines, '', `[Open the board](${link})`].join('\n'),
  )
}
