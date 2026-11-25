/**
 * Squadboard operations — the only code that writes Squadboard data.
 *
 * Called from server actions (UI), agent tools (local agents via the CLI),
 * the demo job and cron. The store underneath runs RBAC-off, so this file is
 * the authorization boundary:
 *   - every read/write of team data first checks the caller is an active
 *     member of that team (`requireMember`);
 *   - agent tools additionally require the agent to belong to the caller
 *     (`requireOwnedAgent`), so nobody can drive someone else's agent;
 *   - steering (directives, answers, overlap status) is open to any member,
 *     because steering each other's agents is the point of the product.
 *
 * Every string that came from an agent or user is length-capped here.
 */

import {
  cleanFileList,
  dayKey,
  detectOverlaps,
  isActive,
  parsePrUrl,
  parseRepoRef,
  rankReadyTasks,
  type ImportEdges,
  type Overlap,
  type TaskLite,
} from './engine'
import {
  INVITE_TTL_MS,
  INVITES_PER_USER_PER_DAY,
  MAX_GOAL_BODY,
  MAX_NAME,
  MAX_QUESTION,
  MAX_SUMMARY,
  MAX_TITLE,
  PR_REFRESH_MAX_PER_RUN,
  PR_REFRESH_MIN_GAP_MS,
  TEAMS_PER_USER_PER_DAY,
} from './config'
import type { GitHubClient } from './github'
import { OpsError, type Row, type Store } from './store'

// ── Row shapes ─────────────────────────────────────────────────────────────

export interface Team {
  teamId: string
  name: string
  ownerId: string
  lastActivityAt?: number
}
export interface Member {
  teamId: string
  userId: string
  status?: 'active' | 'removed'
  role: 'owner' | 'member'
  userName?: string
  userImage?: string
}
export interface Invite {
  teamId: string
  code: string
  createdBy: string
  expiresAt: number
  usedBy?: string
}
export interface Project {
  teamId: string
  repoOwner: string
  repoName: string
  defaultBranch: string
  description?: string
  kind: 'repo' | 'sample'
  prCheckedAt?: number
  mirrorIssues?: number
  mirrorBy?: string
  ghSyncedAt?: number
  ghSyncError?: string
}
export type GoalStatus = 'planning' | 'planned' | 'active' | 'done' | 'failed'
export interface Goal {
  teamId: string
  projectId: string
  title: string
  body?: string
  status: GoalStatus
  planStage?: string
  planError?: string
  planModel?: string
  planSummary?: string
  importEdges?: ImportEdges
  createdByName?: string
  source?: 'planner' | 'sample'
  demoState?: string
  sourceIssueNumber?: number
  sourceIssueUrl?: string
}
export type TaskStatus = 'ready' | 'assigned' | 'in_progress' | 'blocked' | 'paused' | 'review' | 'done'
export interface Task {
  teamId: string
  projectId: string
  goalId: string
  title: string
  body?: string
  acceptance?: string
  predictedFiles?: string[]
  dependsOn?: string[]
  order: number
  status: TaskStatus
  agentId?: string | null
  touchedFiles?: string[]
  lastSummary?: string
  prUrl?: string | null
  prState?: string
  updatedAtMs?: number
  issueNumber?: number | null
  issueUrl?: string
  ghStatus?: string
  lastAgentId?: string | null
  reviewNote?: string
  mergeAlerted?: number
}
export interface Claim {
  teamId: string
  taskId: string
  agentId: string
}
export type AgentStatus = 'idle' | 'working' | 'paused' | 'offline'
export interface Agent {
  teamId: string
  projectId: string
  name: string
  ownerUserId: string
  ownerName?: string
  kind: 'cli' | 'demo'
  status: AgentStatus
  currentTaskId?: string | null
  lastSeenAt?: number
  lastSummary?: string
}
export type DirectiveKind = 'pause' | 'resume' | 'reassign' | 'answer' | 'note'
export interface Directive {
  teamId: string
  agentId: string
  kind: DirectiveKind
  text?: string
  targetTaskId?: string
  createdBy: string
  createdByName?: string
  deliveredAt?: number | null
}
export interface Question {
  teamId: string
  projectId: string
  agentId: string
  taskId?: string
  text: string
  answer?: string
  answeredByName?: string
  status: 'open' | 'answered'
}
export interface OverlapRow {
  teamId: string
  projectId: string
  key: string
  taskA: string
  taskB: string
  files: string[]
  kind: 'same-file' | 'import-neighbor'
  status: 'open' | 'acknowledged' | 'resolved'
}
export type EventKind =
  | 'team'
  | 'plan'
  | 'assign'
  | 'check_in'
  | 'question'
  | 'answer'
  | 'directive'
  | 'overlap'
  | 'complete'
  | 'agent'
  | 'demo'
  | 'review'
  | 'github'
export interface EventRow {
  teamId: string
  projectId?: string
  agentId?: string
  taskId?: string
  kind: EventKind
  message: string
  files?: string[]
  actorName?: string
  at: number
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function clip(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const s = value.replace(/\u0000/g, '').trim()
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…'
}

function requireText(value: unknown, max: number, label: string): string {
  const s = clip(value, max)
  if (!s) throw new OpsError('invalid_input', `${label} is required`)
  return s
}

export function toLite(row: Row<Task>): TaskLite {
  return {
    id: row.recordId,
    title: row.data.title,
    status: row.data.status,
    order: row.data.order ?? 0,
    predictedFiles: row.data.predictedFiles ?? [],
    touchedFiles: row.data.touchedFiles ?? [],
    dependsOn: row.data.dependsOn ?? [],
    agentId: row.data.agentId ?? null,
  }
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export function inviteCode(length = 8): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
}

const CHECKIN_TO_TASK: Record<string, TaskStatus> = {
  working: 'in_progress',
  blocked: 'blocked',
  // Older agents may still send "review" while checking their work; that's still in progress.
  // (Review now means "submitted, waiting for a human" — set by complete_task.)
  review: 'in_progress',
}

/** What a PR description must contain so Squadboard links it to the task (decision #19). */
export function prInstructions(taskId: string, issueNumber?: number | null): string {
  return issueNumber
    ? `In your pull request description include the lines "Closes #${issueNumber}" and "Squadboard-Task: ${taskId}".`
    : `In your pull request description include the line "Squadboard-Task: ${taskId}".`
}

export interface HistoryItem {
  at: string
  who: string
  kind: string
  message: string
  files?: string[]
}

export interface OpsContext {
  store: Store
  /** Verified caller. For cron this is the app owner; for the demo job, the user who started it. */
  userId: string
  now?: () => number
  /** GitHub reader billed to the caller (absent where no billed reads are allowed). */
  github?: GitHubClient
  /**
   * The caller's profile from their verified sign-in token. The users row is
   * created asynchronously on first connect, so a brand-new user's first
   * action can arrive before it exists.
   */
  self?: { name?: string; email?: string; image?: string }
  /** Local dev/test only (ALLOW_DEBUG_ROUTES): multiply rate limits by 100 so repeated test runs don't trip them. */
  relaxedLimits?: boolean
}

/** What an agent sees about one overlap. */
export interface OverlapView {
  kind: OverlapRow['kind']
  status: OverlapRow['status']
  files: string[]
  otherTaskId: string
  otherTaskTitle: string
  otherAgentName: string | null
  otherAgentSummary: string | null
}

export interface DirectiveView {
  kind: DirectiveKind
  text: string
  from: string
}

export interface TaskView {
  taskId: string
  title: string
  body: string
  acceptance: string
  predictedFiles: string[]
  touchedFiles: string[]
  status: TaskStatus
  /** The goal's instructions (its title is for people and isn't sent to agents). */
  goalInstructions?: string
  repo?: string
  branch?: string
  issue?: { number: number; url: string } | null
  reviewNote?: string
  /** Earlier work on this task (other agents, review notes), newest first. */
  history?: HistoryItem[]
  prInstructions?: string
}

// ── Operations ─────────────────────────────────────────────────────────────

export class Ops {
  readonly store: Store
  readonly userId: string
  private readonly clock: () => number
  private readonly github?: GitHubClient
  private readonly self?: OpsContext['self']
  private readonly limitScale: number
  private nameCache = new Map<string, string>()

  constructor(ctx: OpsContext) {
    this.store = ctx.store
    this.userId = ctx.userId
    this.clock = ctx.now ?? Date.now
    this.github = ctx.github
    this.self = ctx.self
    this.limitScale = ctx.relaxedLimits ? 100 : 1
  }

  now(): number {
    return this.clock()
  }

  // ── Access ──────────────────────────────────────────────────────────────

  async membership(teamId: string, userId = this.userId): Promise<Row<Member> | null> {
    if (!teamId) return null
    const rows = await this.store.query<Member>('team_members', { teamId, userId })
    return rows.find((r) => r.data.status !== 'removed') ?? null
  }

  async requireMember(teamId: string): Promise<Row<Member>> {
    const m = await this.membership(teamId)
    if (!m) throw new OpsError('not_member', 'You are not a member of this team', 403)
    return m
  }

  /** Load a team-owned record and check the caller belongs to its team. Not-member and missing look the same. */
  async loadForMember<T extends { teamId: string }>(collection: string, id: string, label: string): Promise<Row<T>> {
    const row = typeof id === 'string' && id ? await this.store.get<T>(collection, id) : null
    if (!row || !(await this.membership(row.data.teamId))) {
      throw new OpsError('not_found', `${label} not found`, 404)
    }
    return row
  }

  async requireOwnedAgent(agentId: string): Promise<Row<Agent>> {
    const agent = await this.loadForMember<Agent>('agents', agentId, 'Agent')
    if (agent.data.ownerUserId !== this.userId) {
      throw new OpsError('not_your_agent', 'This agent belongs to another user', 403)
    }
    return agent
  }

  async userName(userId = this.userId): Promise<string> {
    const cached = this.nameCache.get(userId)
    if (cached) return cached
    const row = await this.store.get<{ name?: string; email?: string }>('users', userId)
    const hint = userId === this.userId ? this.self : undefined
    const name =
      clip(row?.data.name, MAX_NAME) ||
      clip(hint?.name, MAX_NAME) ||
      clip((row?.data.email ?? hint?.email)?.split('@')[0], MAX_NAME) ||
      'Someone'
    this.nameCache.set(userId, name)
    return name
  }

  /** The caller's own email: their users row, else their verified sign-in token. */
  async myEmail(): Promise<string | undefined> {
    const row = await this.store.get<{ email?: string }>('users', this.userId)
    return row?.data.email || this.self?.email || undefined
  }

  /** Fixed-window counter; throws `rate_limited` once `limit` is reached. */
  async bump(bucket: string, limit: number, windowKey = dayKey(this.now()), subject = this.userId): Promise<number> {
    const key = `${bucket}:${subject}:${windowKey}`
    const [row] = await this.store.query<{ key: string; count: number }>('usage_counters', { key })
    const count = row?.data.count ?? 0
    limit *= this.limitScale
    if (count >= limit) {
      throw new OpsError('rate_limited', `Limit reached (${limit} per ${windowKey.length > 10 ? 'hour' : 'day'}). Try again later.`, 429)
    }
    if (row) await this.store.update('usage_counters', row.recordId, { count: count + 1 })
    else if (!(await this.store.tryCreate('usage_counters', { key, count: 1 }))) {
      // Lost a creation race: count on the winner's row.
      const [winner] = await this.store.query<{ key: string; count: number }>('usage_counters', { key })
      if (winner) await this.store.update('usage_counters', winner.recordId, { count: winner.data.count + 1 })
    }
    return count + 1
  }

  async log(event: Omit<EventRow, 'at' | 'actorName'> & { actorName?: string }): Promise<void> {
    await this.store.create<EventRow>('events', {
      ...event,
      message: clip(event.message, 400),
      files: event.files?.slice(0, 20),
      actorName: event.actorName ?? (await this.userName()),
      at: this.now(),
    })
  }

  // ── Teams ───────────────────────────────────────────────────────────────

  async createTeam(name: unknown): Promise<{ teamId: string }> {
    const teamName = requireText(name, MAX_NAME, 'Team name')
    await this.bump('team-create', TEAMS_PER_USER_PER_DAY)
    const teamId = crypto.randomUUID()
    await this.store.create<Team>('teams', { teamId, name: teamName, ownerId: this.userId, lastActivityAt: this.now() }, teamId)
    const userRow = await this.store.get<{ imageUrl?: string; image?: string }>('users', this.userId)
    await this.store.create<Member>('team_members', {
      teamId,
      userId: this.userId,
      status: 'active',
      role: 'owner',
      userName: await this.userName(),
      userImage: clip(userRow?.data.imageUrl ?? userRow?.data.image ?? this.self?.image, 500),
    })
    await this.log({ teamId, kind: 'team', message: `created the team “${teamName}”` })
    return { teamId }
  }

  async createInvite(teamId: string): Promise<{ code: string; expiresAt: number }> {
    await this.requireMember(teamId)
    await this.bump('invite', INVITES_PER_USER_PER_DAY)
    const expiresAt = this.now() + INVITE_TTL_MS
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = inviteCode()
      if (await this.store.tryCreate<Invite>('team_invites', { teamId, code, createdBy: this.userId, expiresAt, usedBy: '' })) {
        return { code, expiresAt }
      }
    }
    throw new OpsError('invite_failed', 'Could not create an invite, please retry', 503)
  }

  async joinTeam(rawCode: unknown): Promise<{ teamId: string; alreadyMember: boolean }> {
    const code = clip(rawCode, 20).toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (code.length !== 8) throw new OpsError('invalid_invite', 'That invite code is not valid')
    const [invite] = await this.store.query<Invite>('team_invites', { code })
    if (!invite) throw new OpsError('invalid_invite', 'That invite code is not valid', 404)
    const { teamId } = invite.data
    if (await this.membership(teamId)) return { teamId, alreadyMember: true }
    if (invite.data.usedBy) throw new OpsError('invite_used', 'That invite has already been used', 410)
    if (invite.data.expiresAt < this.now()) throw new OpsError('invite_expired', 'That invite has expired', 410)
    await this.store.update<Invite>('team_invites', invite.recordId, { usedBy: this.userId })
    const fields: Member = {
      teamId,
      userId: this.userId,
      status: 'active',
      role: 'member',
      userName: await this.userName(),
    }
    const [old] = await this.store.query<Member>('team_members', { teamId, userId: this.userId })
    if (old) await this.store.update<Member>('team_members', old.recordId, { ...fields, role: old.data.role })
    else await this.store.create<Member>('team_members', fields)
    await this.log({ teamId, kind: 'team', message: 'joined the team' })
    return { teamId, alreadyMember: false }
  }

  /**
   * The owner removes a member. Every membership check skips removed rows, so their access (and their
   * agents', which act as them) ends at once; tasks their agents held go back to Ready. A new invite
   * brings them back.
   */
  async removeMember(teamId: string, memberUserId: unknown): Promise<void> {
    const me = await this.requireMember(teamId)
    if (me.data.role !== 'owner') throw new OpsError('not_owner', 'Only the team owner can remove members', 403)
    const userId = clip(memberUserId, 100)
    if (userId === this.userId) throw new OpsError('invalid_input', "You can't remove yourself from your own team")
    const member = (await this.store.query<Member>('team_members', { teamId, userId })).find((m) => m.data.status !== 'removed')
    if (!member) throw new OpsError('not_found', 'Member not found', 404)
    await this.store.update<Member>('team_members', member.recordId, { status: 'removed' })

    const projects = new Set<string>()
    for (const agent of await this.store.query<Agent>('agents', { teamId, ownerUserId: userId })) {
      const task = agent.data.currentTaskId ? await this.store.get<Task>('tasks', agent.data.currentTaskId) : null
      if (task && task.data.agentId === agent.recordId && ['assigned', 'in_progress', 'blocked', 'paused'].includes(task.data.status)) {
        for (const c of await this.store.query<Claim>('task_claims', { taskId: task.recordId })) await this.store.remove('task_claims', c.recordId)
        await this.store.update<Task>('tasks', task.recordId, { status: 'ready', agentId: null, lastAgentId: agent.recordId, updatedAtMs: this.now() })
        projects.add(task.data.projectId)
      }
      await this.store.update<Agent>('agents', agent.recordId, { status: 'offline', currentTaskId: null })
    }
    for (const projectId of projects) await this.recomputeOverlaps(teamId, projectId)
    await this.log({ teamId, kind: 'team', message: `removed ${member.data.userName || 'a member'} from the team` })
  }

  // ── Projects ────────────────────────────────────────────────────────────

  async createProject(teamId: string, repoRef: unknown): Promise<{ projectId: string; existed: boolean }> {
    await this.requireMember(teamId)
    const ref = parseRepoRef(clip(repoRef, 300))
    if (!ref) throw new OpsError('invalid_repo', 'Enter a public GitHub repository as owner/name or its URL')
    const existing = (await this.store.query<Project>('projects', { teamId })).find(
      (p) =>
        p.data.kind === 'repo' &&
        p.data.repoOwner.toLowerCase() === ref.owner.toLowerCase() &&
        p.data.repoName.toLowerCase() === ref.repo.toLowerCase(),
    )
    if (existing) return { projectId: existing.recordId, existed: true }
    if (!this.github) throw new OpsError('unavailable', 'GitHub access is not available here', 503)
    let info
    try {
      info = await this.github.getRepository(ref.owner, ref.repo)
    } catch (e) {
      const status = (e as { status?: number }).status
      if (status === 404 || status === 403) {
        throw new OpsError('repo_not_found', `Couldn't find ${ref.owner}/${ref.repo}. If it's private, connect your GitHub account first (link below the box).`, 404)
      }
      throw e
    }
    // A private repo only gets here when it was read through the caller's own GitHub
    // connection (decision #20), so they have access to it.
    const [owner, name] = info.fullName.includes('/') ? info.fullName.split('/') : [ref.owner, ref.repo]
    const projectId = await this.store.create<Project>('projects', {
      teamId,
      repoOwner: owner!,
      repoName: name!,
      defaultBranch: info.defaultBranch,
      description: clip(info.description, 300),
      kind: 'repo',
    })
    await this.log({ teamId, projectId, kind: 'team', message: `added the project ${owner}/${name}` })
    return { projectId, existed: false }
  }

  /** Every project in every team the caller belongs to. */
  async myProjects(): Promise<Array<{ teamId: string; teamName: string; projectId: string; repo: string; kind: Project['kind'] }>> {
    const out = []
    const memberships = (await this.store.query<Member>('team_members', { userId: this.userId })).filter((m) => m.data.status !== 'removed')
    for (const m of memberships) {
      const team = await this.store.get<Team>('teams', m.data.teamId)
      for (const p of await this.store.query<Project>('projects', { teamId: m.data.teamId })) {
        out.push({ teamId: m.data.teamId, teamName: team?.data.name ?? '', projectId: p.recordId, repo: `${p.data.repoOwner}/${p.data.repoName}`, kind: p.data.kind })
      }
    }
    return out
  }

  /** A project id, or "owner/repo" when it names exactly one of the caller's projects. */
  async resolveProject(ref: unknown): Promise<string> {
    const value = clip(ref, 300)
    if (!value) throw new OpsError('invalid_input', 'project is required (a project id or owner/repo)')
    const repo = parseRepoRef(value)
    if (!repo) return value
    const matches = (await this.myProjects()).filter((p) => p.repo.toLowerCase() === `${repo.owner}/${repo.repo}`.toLowerCase())
    if (matches.length === 1) return matches[0]!.projectId
    if (!matches.length) throw new OpsError('not_found', `None of your teams has a project for ${value}. Add it on the Squadboard board first.`, 404)
    throw new OpsError('ambiguous', `${value} is a project in several of your teams; pass the project id instead (see list_projects).`, 409)
  }

  // ── Goals ───────────────────────────────────────────────────────────────

  async createGoal(projectId: string, title: unknown, body: unknown): Promise<{ goalId: string; project: Row<Project> }> {
    const project = await this.loadForMember<Project>('projects', projectId, 'Project')
    // Title: a short name for people. Instructions: what to build — the only goal text the planner and agents get.
    const goalTitle = requireText(title, MAX_TITLE, 'Title')
    const instructions = requireText(body, MAX_GOAL_BODY, 'Instructions')
    const goalId = await this.store.create<Goal>('goals', {
      teamId: project.data.teamId,
      projectId,
      title: goalTitle,
      body: instructions,
      status: 'planning',
      planStage: 'queued',
      createdByName: await this.userName(),
      source: 'planner',
      demoState: '',
    })
    await this.log({ teamId: project.data.teamId, projectId, kind: 'plan', message: `set a goal: ${goalTitle}` })
    return { goalId, project }
  }

  // ── Agents ──────────────────────────────────────────────────────────────

  async registerAgent(projectId: string, rawName: unknown, kind: Agent['kind'] = 'cli'): Promise<{ agentId: string; created: boolean }> {
    const project = await this.loadForMember<Project>('projects', projectId, 'Project')
    const name = requireText(rawName, 40, 'Agent name').replace(/\s+/g, ' ')
    const [existing] = await this.store.query<Agent>('agents', { projectId, ownerUserId: this.userId, name })
    if (existing) {
      const status: AgentStatus =
        existing.data.status === 'paused' ? 'paused' : existing.data.currentTaskId ? 'working' : 'idle'
      await this.store.update<Agent>('agents', existing.recordId, { lastSeenAt: this.now(), status, kind })
      return { agentId: existing.recordId, created: false }
    }
    const agentId = await this.store.create<Agent>('agents', {
      teamId: project.data.teamId,
      projectId,
      name,
      ownerUserId: this.userId,
      ownerName: await this.userName(),
      kind,
      status: 'idle',
      currentTaskId: null,
      lastSeenAt: this.now(),
      lastSummary: '',
    })
    await this.log({ teamId: project.data.teamId, projectId, agentId, kind: 'agent', message: `connected agent “${name}”` })
    return { agentId, created: true }
  }

  async projectTasks(projectId: string): Promise<Row<Task>[]> {
    return this.store.query<Task>('tasks', { projectId })
  }

  async projectEdges(projectId: string): Promise<ImportEdges> {
    const goals = await this.store.query<Goal>('goals', { projectId })
    const edges: ImportEdges = {}
    for (const g of goals) {
      for (const [from, to] of Object.entries(g.data.importEdges ?? {})) {
        edges[from] = [...new Set([...(edges[from] ?? []), ...to])]
      }
    }
    return edges
  }

  private taskView(row: Row<Task>, extra: Partial<TaskView> = {}): TaskView {
    return {
      taskId: row.recordId,
      title: row.data.title,
      body: row.data.body ?? '',
      acceptance: row.data.acceptance ?? '',
      predictedFiles: row.data.predictedFiles ?? [],
      touchedFiles: row.data.touchedFiles ?? [],
      status: row.data.status,
      issue: row.data.issueNumber ? { number: row.data.issueNumber, url: row.data.issueUrl ?? '' } : null,
      ...(row.data.reviewNote ? { reviewNote: row.data.reviewNote } : {}),
      ...extra,
    }
  }

  /** A task's timeline from the activity log, newest first. */
  async taskHistory(taskId: string, limit = 12): Promise<HistoryItem[]> {
    const rows = await this.store.query<EventRow>('events', { taskId }, { orderBy: 'at', orderDir: 'desc', limit })
    return rows.map((e) => ({
      at: new Date(e.data.at).toISOString(),
      who: e.data.actorName ?? '',
      kind: e.data.kind,
      message: e.data.message,
      ...(e.data.files?.length ? { files: e.data.files } : {}),
    }))
  }

  private async taskContext(row: Row<Task>): Promise<TaskView> {
    const [goal, project] = await Promise.all([
      this.store.get<Goal>('goals', row.data.goalId),
      this.store.get<Project>('projects', row.data.projectId),
    ])
    const history = await this.taskHistory(row.recordId)
    return this.taskView(row, {
      goalInstructions: clip(goal?.data.body, 1500) || undefined,
      repo: project ? `${project.data.repoOwner}/${project.data.repoName}` : undefined,
      branch: project?.data.defaultBranch,
      // Only worth sending when someone else worked on it before (handoff).
      ...(history.some((h) => h.kind !== 'plan') ? { history } : {}),
      prInstructions: prInstructions(row.recordId, row.data.issueNumber),
    })
  }

  /** Pending directives for an agent, marked delivered. Oldest first. */
  async deliverDirectives(agentId: string): Promise<DirectiveView[]> {
    const rows = (await this.store.query<Directive>('directives', { agentId })).filter((d) => !d.data.deliveredAt)
    rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const now = this.now()
    for (const d of rows) await this.store.update<Directive>('directives', d.recordId, { deliveredAt: now })
    return rows.map((d) => ({ kind: d.data.kind, text: d.data.text ?? '', from: d.data.createdByName ?? 'a teammate' }))
  }

  async nextTask(agentId: string): Promise<{
    task: TaskView | null
    status: AgentStatus
    message: string
    overlaps: OverlapView[]
    directives: DirectiveView[]
  }> {
    const agent = await this.requireOwnedAgent(agentId)
    const directives = await this.deliverDirectives(agentId)
    const fresh = (await this.store.get<Agent>('agents', agentId))!
    const { teamId, projectId } = fresh.data
    await this.store.update<Agent>('agents', agentId, { lastSeenAt: this.now() })

    if (fresh.data.status === 'paused') {
      return { task: null, status: 'paused', message: 'You are paused by a teammate. Stop work and check in again later.', overlaps: [], directives }
    }
    if (fresh.data.currentTaskId) {
      const current = await this.store.get<Task>('tasks', fresh.data.currentTaskId)
      if (current && current.data.agentId === agentId && current.data.status !== 'done') {
        const overlaps = await this.overlapViews(projectId, current.recordId)
        return { task: await this.taskContext(current), status: fresh.data.status, message: 'Continue your current task.', overlaps, directives }
      }
    }

    const tasks = await this.projectTasks(projectId)
    // A task sent back from review is held for the agent that did it (it has the
    // context) while that agent is still online; it goes first in that agent's list.
    const agents = new Map((await this.store.query<Agent>('agents', { projectId })).map((a) => [a.recordId, a]))
    const heldForOther = (t: Row<Task> | undefined) =>
      !!t?.data.reviewNote && !!t.data.lastAgentId && t.data.lastAgentId !== agentId && agents.get(t.data.lastAgentId)?.data.status !== 'offline'
    const ranked = rankReadyTasks(tasks.map(toLite), await this.projectEdges(projectId))
      .filter((r) => !heldForOther(tasks.find((t) => t.recordId === r.task.id)))
      .sort((x, y) => {
        const mine = (t: TaskLite) => (tasks.find((r) => r.recordId === t.id)?.data.lastAgentId === agentId ? 0 : 1)
        return mine(x.task) - mine(y.task)
      })
    for (const candidate of ranked) {
      const claimed = await this.store.tryCreate<Claim>('task_claims', { teamId, taskId: candidate.task.id, agentId })
      if (!claimed) continue
      const row = tasks.find((t) => t.recordId === candidate.task.id)!
      await this.store.update<Task>('tasks', row.recordId, { status: 'assigned', agentId, updatedAtMs: this.now() })
      await this.store.update<Agent>('agents', agentId, { status: 'working', currentTaskId: row.recordId })
      const goal = await this.store.get<Goal>('goals', row.data.goalId)
      if (goal?.data.status === 'planned') await this.store.update<Goal>('goals', goal.recordId, { status: 'active' })
      await this.log({ teamId, projectId, agentId, taskId: row.recordId, kind: 'assign', message: `${agent.data.name} took “${row.data.title}”`, actorName: agent.data.name })
      await this.recomputeOverlaps(teamId, projectId)
      const claimedRow = { ...row, data: { ...row.data, status: 'assigned' as const, agentId } }
      const overlaps = await this.overlapViews(projectId, row.recordId)
      const message = overlaps.length
        ? 'Task assigned. It overlaps with work in progress — read the overlaps before editing those files.'
        : 'Task assigned.'
      return { task: await this.taskContext(claimedRow), status: 'working', message, overlaps, directives }
    }

    await this.store.update<Agent>('agents', agentId, { status: 'idle', currentTaskId: null })
    // Ready tasks whose dependencies aren't done yet. (Tasks just lost to another
    // agent's claim were rankable, so they don't count as waiting.)
    const rankable = new Set(ranked.map((r) => r.task.id))
    const waiting = tasks.filter((t) => t.data.status === 'ready' && !rankable.has(t.recordId)).length
    return {
      task: null,
      status: 'idle',
      message: waiting
        ? `No task is ready yet: ${waiting} task(s) wait on others to finish. Check again in a few minutes.`
        : 'Nothing to do: every task is taken or done.',
      overlaps: [],
      directives,
    }
  }

  async checkIn(
    agentId: string,
    input: { status?: unknown; summary?: unknown; files?: unknown },
  ): Promise<{ task: TaskView | null; agentStatus: AgentStatus; directives: DirectiveView[]; overlaps: OverlapView[]; message: string }> {
    const agent = await this.requireOwnedAgent(agentId)
    const { teamId, projectId } = agent.data
    const summary = clip(input.summary, MAX_SUMMARY)
    const files = cleanFileList(input.files)
    const reported = typeof input.status === 'string' && input.status in CHECKIN_TO_TASK ? input.status : 'working'

    let task = agent.data.currentTaskId ? await this.store.get<Task>('tasks', agent.data.currentTaskId) : null
    if (task && task.data.agentId !== agentId) task = null

    const agentStatus: AgentStatus = agent.data.status === 'paused' ? 'paused' : task ? 'working' : 'idle'
    await this.store.update<Agent>('agents', agentId, {
      lastSeenAt: this.now(),
      status: agentStatus,
      ...(summary ? { lastSummary: summary } : {}),
    })

    if (task) {
      const before = new Set([...(task.data.touchedFiles ?? []), ...(task.data.predictedFiles ?? [])])
      const newFiles = files.filter((f) => !before.has(f))
      const touched = [...new Set([...(task.data.touchedFiles ?? []), ...files])].slice(0, 100)
      const status: TaskStatus = task.data.status === 'paused' ? 'paused' : CHECKIN_TO_TASK[reported]!
      const patch: Partial<Task> = { touchedFiles: touched, status, updatedAtMs: this.now() }
      if (summary) patch.lastSummary = summary
      await this.store.update<Task>('tasks', task.recordId, patch)
      task = { ...task, data: { ...task.data, ...patch } }
      if (summary || files.length) {
        await this.log({ teamId, projectId, agentId, taskId: task.recordId, kind: 'check_in', message: summary || `touched ${files.length} file(s)`, files, actorName: agent.data.name })
      }
      if (newFiles.length) await this.recomputeOverlaps(teamId, projectId)
    }

    const directives = await this.deliverDirectives(agentId)
    // A pause/reassign delivered just now may have changed things.
    const after = (await this.store.get<Agent>('agents', agentId))!
    const overlaps = after.data.currentTaskId ? await this.overlapViews(projectId, after.data.currentTaskId) : []
    const currentTask = after.data.currentTaskId ? await this.store.get<Task>('tasks', after.data.currentTaskId) : null
    let message = 'Checked in.'
    if (after.data.status === 'paused') message = 'You are paused. Stop editing and check in again later.'
    else if (!after.data.currentTaskId) {
      message = directives.some((d) => d.kind === 'reassign')
        ? 'Your task was reassigned to someone else. Stop work on it, keep nothing half-done in shared files, and call next_task.'
        : 'You have no task. Call next_task.'
    }
    else if (overlaps.some((o) => o.status === 'open')) message = 'Checked in. Heads up: your work overlaps with another agent — see overlaps.'
    return {
      task: currentTask ? this.taskView(currentTask) : null,
      agentStatus: after.data.status,
      directives,
      overlaps,
      message,
    }
  }

  async getTask(agentId: string, taskId?: string): Promise<TaskView & { dependsOnTitles: string[] }> {
    const agent = await this.requireOwnedAgent(agentId)
    const id = taskId || agent.data.currentTaskId
    if (!id) throw new OpsError('no_task', 'You have no current task. Call next_task.', 404)
    const task = await this.loadForMember<Task>('tasks', id, 'Task')
    if (task.data.projectId !== agent.data.projectId) throw new OpsError('not_found', 'Task not found', 404)
    const deps = await Promise.all((task.data.dependsOn ?? []).map((d) => this.store.get<Task>('tasks', d)))
    return { ...(await this.taskContext(task)), dependsOnTitles: deps.filter(Boolean).map((d) => `${d!.data.title} (${d!.data.status})`) }
  }

  async askHuman(agentId: string, text: unknown): Promise<{ questionId: string }> {
    const agent = await this.requireOwnedAgent(agentId)
    const question = requireText(text, MAX_QUESTION, 'Question')
    const { teamId, projectId } = agent.data
    const questionId = await this.store.create<Question>('questions', {
      teamId,
      projectId,
      agentId,
      taskId: agent.data.currentTaskId ?? '',
      text: question,
      status: 'open',
    })
    await this.log({ teamId, projectId, agentId, taskId: agent.data.currentTaskId ?? undefined, kind: 'question', message: `${agent.data.name} asked: ${question}`, actorName: agent.data.name })
    return { questionId }
  }

  async completeTask(agentId: string, input: { summary?: unknown; prUrl?: unknown }): Promise<{ submitted: boolean; prUrl: string | null; message: string }> {
    const agent = await this.requireOwnedAgent(agentId)
    const { teamId, projectId } = agent.data
    const taskId = agent.data.currentTaskId
    const task = taskId ? await this.store.get<Task>('tasks', taskId) : null
    if (!task || task.data.agentId !== agentId) throw new OpsError('no_task', 'You have no current task to complete', 409)
    const summary = clip(input.summary, MAX_SUMMARY)

    let prUrl: string | null = task.data.prUrl ?? null
    let note = ''
    if (typeof input.prUrl === 'string' && input.prUrl.trim()) {
      const pr = parsePrUrl(input.prUrl)
      const project = await this.store.get<Project>('projects', projectId)
      const sameRepo =
        pr && project &&
        pr.owner.toLowerCase() === project.data.repoOwner.toLowerCase() &&
        pr.repo.toLowerCase() === project.data.repoName.toLowerCase()
      if (pr && (sameRepo || project?.data.kind === 'sample')) prUrl = `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`
      else note = ' The PR link was ignored: it must be a pull request URL in this project’s repository.'
    }

    // Review gate (decision #21): the agent is done; a human approves (or a merged PR does).
    await this.store.update<Task>('tasks', task.recordId, {
      status: 'review',
      lastSummary: summary || task.data.lastSummary || '',
      prUrl,
      prState: prUrl ? task.data.prState || 'open' : '',
      lastAgentId: agentId,
      reviewNote: '',
      updatedAtMs: this.now(),
    })
    for (const claim of await this.store.query<Claim>('task_claims', { taskId: task.recordId })) {
      await this.store.remove('task_claims', claim.recordId)
    }
    await this.store.update<Agent>('agents', agentId, { status: agent.data.status === 'paused' ? 'paused' : 'idle', currentTaskId: null, lastSeenAt: this.now(), ...(summary ? { lastSummary: summary } : {}) })
    await this.log({ teamId, projectId, agentId, taskId: task.recordId, kind: 'complete', message: `${agent.data.name} submitted “${task.data.title}” for review${prUrl ? ' with a PR' : ''}`, actorName: agent.data.name })
    return { submitted: true, prUrl, message: `Submitted for review — a teammate will approve it or send it back with notes.${note} Call next_task for more work.` }
  }

  /** Mark a task done (approval or merged PR) and close its goal when every task is done. */
  async markDone(task: Row<Task>, actorName: string, message: string): Promise<{ goalDone: boolean }> {
    const { teamId, projectId } = task.data
    await this.store.update<Task>('tasks', task.recordId, { status: 'done', updatedAtMs: this.now() })
    for (const claim of await this.store.query<Claim>('task_claims', { taskId: task.recordId })) {
      await this.store.remove('task_claims', claim.recordId)
    }
    if (task.data.agentId) {
      const agent = await this.store.get<Agent>('agents', task.data.agentId)
      if (agent?.data.currentTaskId === task.recordId) {
        await this.store.update<Agent>('agents', agent.recordId, { currentTaskId: null, status: agent.data.status === 'paused' ? 'paused' : 'idle' })
      }
    }
    await this.log({ teamId, projectId, agentId: task.data.agentId ?? undefined, taskId: task.recordId, kind: 'review', message, actorName })
    await this.recomputeOverlaps(teamId, projectId)
    const goalTasks = await this.store.query<Task>('tasks', { goalId: task.data.goalId })
    const goalDone = goalTasks.every((t) => (t.recordId === task.recordId ? true : t.data.status === 'done'))
    if (goalDone) {
      const goal = await this.store.get<Goal>('goals', task.data.goalId)
      if (goal && goal.data.status !== 'done') {
        await this.store.update<Goal>('goals', goal.recordId, { status: 'done' })
        await this.log({ teamId, projectId, kind: 'plan', message: `goal done: ${goal.data.title}`, actorName })
      }
    }
    return { goalDone }
  }

  async approveTask(taskId: string): Promise<{ goalDone: boolean }> {
    const task = await this.loadForMember<Task>('tasks', taskId, 'Task')
    if (task.data.status !== 'review') throw new OpsError('not_in_review', 'Only a task waiting for review can be approved', 409)
    return this.markDone(task, await this.userName(), `approved “${task.data.title}”`)
  }

  async requestChanges(taskId: string, note: unknown): Promise<void> {
    const task = await this.loadForMember<Task>('tasks', taskId, 'Task')
    if (task.data.status !== 'review') throw new OpsError('not_in_review', 'Only a task waiting for review can be sent back', 409)
    const text = requireText(note, MAX_SUMMARY, 'What to change')
    const name = await this.userName()
    const previous = task.data.agentId ?? task.data.lastAgentId ?? null
    await this.store.update<Task>('tasks', taskId, { status: 'ready', agentId: null, lastAgentId: previous, reviewNote: text, updatedAtMs: this.now() })
    await this.log({ teamId: task.data.teamId, projectId: task.data.projectId, taskId, kind: 'review', message: `requested changes on “${task.data.title}”: ${text}` })
    if (previous && (await this.store.get<Agent>('agents', previous))) {
      await this.store.create<Directive>('directives', {
        teamId: task.data.teamId,
        agentId: previous,
        kind: 'note',
        text: clip(`Changes requested on “${task.data.title}”: ${text} It's back in Ready — next_task gives it to you first.`, MAX_SUMMARY + 200),
        targetTaskId: taskId,
        createdBy: this.userId,
        createdByName: name,
        deliveredAt: null,
      })
    }
    await this.recomputeOverlaps(task.data.teamId, task.data.projectId)
  }

  /**
   * A task's PR merged: it counts as approval, and agents working on files it
   * changed are told to pull/rebase before going further (merge alerts).
   */
  async onPrMerged(taskId: string): Promise<{ alerted: string[] }> {
    const task = await this.loadForMember<Task>('tasks', taskId, 'Task')
    if (task.data.status !== 'done') await this.markDone(task, 'Squadboard', `PR merged for “${task.data.title}”`)
    if (task.data.mergeAlerted) return { alerted: [] }
    const files = new Set([...(task.data.predictedFiles ?? []), ...(task.data.touchedFiles ?? [])])
    const edges = await this.projectEdges(task.data.projectId)
    const alerted: string[] = []
    for (const other of await this.projectTasks(task.data.projectId)) {
      if (other.recordId === taskId || !other.data.agentId || !isActive(other.data) || other.data.status === 'review') continue
      const theirs = [...(other.data.predictedFiles ?? []), ...(other.data.touchedFiles ?? [])]
      const shared = theirs.filter((f) => files.has(f))
      const near = shared.length ? [] : theirs.filter((f) => [...files].some((g) => (edges[f] ?? []).includes(g) || (edges[g] ?? []).includes(f)))
      if (!shared.length && !near.length) continue
      const agent = await this.store.get<Agent>('agents', other.data.agentId)
      if (!agent) continue
      await this.store.create<Directive>('directives', {
        teamId: task.data.teamId,
        agentId: agent.recordId,
        kind: 'note',
        text: clip(`“${task.data.title}” was merged and changed ${shared.length ? shared.join(', ') : 'files next to yours (' + near.join(', ') + ')'}. Pull the latest default branch and rebase before you continue.`, MAX_SUMMARY),
        targetTaskId: other.recordId,
        createdBy: this.userId,
        createdByName: 'Squadboard',
        deliveredAt: null,
      })
      alerted.push(agent.data.name)
    }
    await this.store.update<Task>('tasks', taskId, { mergeAlerted: 1 })
    if (alerted.length) {
      await this.log({ teamId: task.data.teamId, projectId: task.data.projectId, taskId, kind: 'github', message: `merge alert: told ${alerted.join(', ')} to pull “${task.data.title}”`, actorName: 'Squadboard' })
    }
    return { alerted }
  }

  // ── Overlaps ────────────────────────────────────────────────────────────

  /**
   * Bring the overlaps collection in line with current work in a project:
   * new overlaps open; gone ones resolve; an acknowledged one reopens only
   * if it gained files.
   */
  async recomputeOverlaps(teamId: string, projectId: string): Promise<Overlap[]> {
    const tasks = await this.projectTasks(projectId)
    const found = detectOverlaps(tasks.map(toLite), await this.projectEdges(projectId))
    const existing = await this.store.query<OverlapRow>('overlaps', { projectId })
    const byKey = new Map(existing.map((o) => [o.data.key, o]))
    const titles = new Map(tasks.map((t) => [t.recordId, t.data.title]))
    for (const o of found) {
      const row = byKey.get(o.key)
      if (!row) {
        const created = await this.store.tryCreate<OverlapRow>('overlaps', { teamId, projectId, key: o.key, taskA: o.taskA, taskB: o.taskB, files: o.files, kind: o.kind, status: 'open' })
        if (created) {
          await this.log({ teamId, projectId, kind: 'overlap', message: `overlap (${o.kind}): “${titles.get(o.taskA)}” and “${titles.get(o.taskB)}”`, files: o.kind === 'same-file' ? o.files : undefined, actorName: 'Squadboard' })
        }
        continue
      }
      const gained = o.files.some((f) => !row.data.files.includes(f))
      const sameFiles = !gained && o.files.length === row.data.files.length
      if (row.data.status === 'resolved' || (row.data.status === 'acknowledged' && gained)) {
        await this.store.update<OverlapRow>('overlaps', row.recordId, { status: 'open', files: o.files, kind: o.kind })
      } else if (!sameFiles || row.data.kind !== o.kind) {
        await this.store.update<OverlapRow>('overlaps', row.recordId, { files: o.files, kind: o.kind })
      }
    }
    const live = new Set(found.map((o) => o.key))
    for (const row of existing) {
      if (!live.has(row.data.key) && row.data.status !== 'resolved') {
        await this.store.update<OverlapRow>('overlaps', row.recordId, { status: 'resolved' })
      }
    }
    return found
  }

  async overlapViews(projectId: string, taskId: string): Promise<OverlapView[]> {
    const rows = (await this.store.query<OverlapRow>('overlaps', { projectId })).filter(
      (o) => o.data.status !== 'resolved' && (o.data.taskA === taskId || o.data.taskB === taskId),
    )
    const views: OverlapView[] = []
    for (const o of rows) {
      const otherId = o.data.taskA === taskId ? o.data.taskB : o.data.taskA
      const other = await this.store.get<Task>('tasks', otherId)
      if (!other || !isActive(other.data)) continue
      const otherAgent = other.data.agentId ? await this.store.get<Agent>('agents', other.data.agentId) : null
      views.push({
        kind: o.data.kind,
        status: o.data.status,
        files: o.data.files,
        otherTaskId: otherId,
        otherTaskTitle: other.data.title,
        otherAgentName: otherAgent?.data.name ?? null,
        otherAgentSummary: otherAgent?.data.lastSummary || other.data.lastSummary || null,
      })
    }
    return views
  }

  async setOverlapStatus(overlapId: string, status: unknown): Promise<void> {
    if (status !== 'open' && status !== 'acknowledged' && status !== 'resolved') {
      throw new OpsError('invalid_input', 'Status must be open, acknowledged or resolved')
    }
    const row = await this.loadForMember<OverlapRow>('overlaps', overlapId, 'Overlap')
    await this.store.update<OverlapRow>('overlaps', overlapId, { status })
    await this.log({ teamId: row.data.teamId, projectId: row.data.projectId, kind: 'overlap', message: `marked an overlap ${status}` })
  }

  // ── Human steering ──────────────────────────────────────────────────────

  async sendDirective(agentId: string, kind: unknown, text?: unknown): Promise<{ directiveId: string; message: string }> {
    if (kind !== 'pause' && kind !== 'resume' && kind !== 'reassign' && kind !== 'note') {
      throw new OpsError('invalid_input', 'Directive must be pause, resume, reassign or note')
    }
    const agent = await this.loadForMember<Agent>('agents', agentId, 'Agent')
    const { teamId, projectId } = agent.data
    const note = clip(text, MAX_SUMMARY)
    if (kind === 'note' && !note) throw new OpsError('invalid_input', 'A note needs text')
    const taskId = agent.data.currentTaskId ?? ''
    const task = taskId ? await this.store.get<Task>('tasks', taskId) : null

    let effect = ''
    if (kind === 'pause') {
      await this.store.update<Agent>('agents', agentId, { status: 'paused' })
      if (task && task.data.status !== 'done') await this.store.update<Task>('tasks', task.recordId, { status: 'paused', updatedAtMs: this.now() })
      effect = `paused ${agent.data.name}`
    } else if (kind === 'resume') {
      await this.store.update<Agent>('agents', agentId, { status: task ? 'working' : 'idle' })
      if (task?.data.status === 'paused') await this.store.update<Task>('tasks', task.recordId, { status: 'in_progress', updatedAtMs: this.now() })
      effect = `resumed ${agent.data.name}`
    } else if (kind === 'reassign') {
      if (!task) throw new OpsError('no_task', `${agent.data.name} has no task to take back`, 409)
      for (const claim of await this.store.query<Claim>('task_claims', { taskId: task.recordId })) {
        await this.store.remove('task_claims', claim.recordId)
      }
      await this.store.update<Task>('tasks', task.recordId, { status: 'ready', agentId: null, updatedAtMs: this.now() })
      await this.store.update<Agent>('agents', agentId, { status: agent.data.status === 'paused' ? 'paused' : 'idle', currentTaskId: null })
      await this.recomputeOverlaps(teamId, projectId)
      effect = `took “${task.data.title}” back from ${agent.data.name}; it is ready for another agent`
    } else {
      effect = `sent ${agent.data.name} a note: ${note}`
    }

    const directiveId = await this.store.create<Directive>('directives', {
      teamId,
      agentId,
      kind,
      text: note,
      targetTaskId: taskId,
      createdBy: this.userId,
      createdByName: await this.userName(),
      deliveredAt: null,
    })
    await this.log({ teamId, projectId, agentId, taskId: taskId || undefined, kind: 'directive', message: effect })
    return { directiveId, message: effect }
  }

  async answerQuestion(questionId: string, answer: unknown): Promise<void> {
    const q = await this.loadForMember<Question>('questions', questionId, 'Question')
    const text = requireText(answer, MAX_QUESTION, 'Answer')
    if (q.data.status === 'answered') throw new OpsError('already_answered', 'That question was already answered', 409)
    const name = await this.userName()
    await this.store.update<Question>('questions', questionId, { answer: text, answeredByName: name, status: 'answered' })
    await this.store.create<Directive>('directives', {
      teamId: q.data.teamId,
      agentId: q.data.agentId,
      kind: 'answer',
      text: clip(`Q: ${q.data.text}\nA: ${text}`, MAX_SUMMARY + MAX_QUESTION),
      targetTaskId: q.data.taskId ?? '',
      createdBy: this.userId,
      createdByName: name,
      deliveredAt: null,
    })
    await this.log({ teamId: q.data.teamId, projectId: q.data.projectId, agentId: q.data.agentId, kind: 'answer', message: `answered: ${text}` })
  }

  // ── PR status (user-billed, throttled — decision #17) ────────────────────

  async refreshPrs(projectId: string): Promise<{ checked: number; skipped: 'throttled' | 'none' | null }> {
    const project = await this.loadForMember<Project>('projects', projectId, 'Project')
    if (project.data.kind !== 'repo') return { checked: 0, skipped: 'none' }
    const last = project.data.prCheckedAt ?? 0
    if (this.now() - last < PR_REFRESH_MIN_GAP_MS) return { checked: 0, skipped: 'throttled' }
    const pending = (await this.projectTasks(projectId))
      .filter((t) => t.data.prUrl && t.data.prState !== 'merged' && t.data.prState !== 'closed')
      .slice(0, PR_REFRESH_MAX_PER_RUN)
    await this.store.update<Project>('projects', projectId, { prCheckedAt: this.now() })
    if (!pending.length) return { checked: 0, skipped: 'none' }
    if (!this.github) return { checked: 0, skipped: 'none' }
    let checked = 0
    for (const t of pending) {
      const pr = parsePrUrl(t.data.prUrl!)
      if (!pr) continue
      try {
        const state = await this.github.getPullRequest(pr.owner, pr.repo, pr.number)
        checked++
        if (state !== t.data.prState) await this.store.update<Task>('tasks', t.recordId, { prState: state })
        if (state === 'merged') await this.onPrMerged(t.recordId)
      } catch {
        // One missing PR shouldn't stop the rest.
      }
    }
    return { checked, skipped: null }
  }
}

// ── System jobs (no caller; run by cron) ───────────────────────────────────

/**
 * Stale sweep (cron, as the owner): agents silent for `staleMs` go offline;
 * agents silent for `releaseMs` give their task back to Ready, with a note for
 * when they return (auto-release, decision #21). Demo and paused work is left alone.
 */
export async function sweepStaleAgents(ops: Ops, now: number, staleMs: number, releaseMs = Infinity): Promise<{ offline: number; released: number }> {
  const store = ops.store
  let offline = 0
  let released = 0
  for (const status of ['working', 'idle', 'offline'] as const) {
    for (const a of await store.query<Agent>('agents', { status })) {
      if (a.data.kind === 'demo') continue
      const silentFor = now - (a.data.lastSeenAt ?? 0)
      if (status !== 'offline' && silentFor > staleMs) {
        await store.update<Agent>('agents', a.recordId, { status: 'offline' })
        offline++
      }
      if (silentFor > releaseMs && a.data.currentTaskId) {
        const task = await store.get<Task>('tasks', a.data.currentTaskId)
        if (task && task.data.agentId === a.recordId && ['assigned', 'in_progress', 'blocked'].includes(task.data.status)) {
          for (const c of await store.query<Claim>('task_claims', { taskId: task.recordId })) await store.remove('task_claims', c.recordId)
          await store.update<Task>('tasks', task.recordId, { status: 'ready', agentId: null, lastAgentId: a.recordId, updatedAtMs: now })
          await store.update<Agent>('agents', a.recordId, { currentTaskId: null })
          const hours = Math.round(silentFor / 3_600_000)
          await store.create<Directive>('directives', {
            teamId: a.data.teamId,
            agentId: a.recordId,
            kind: 'note',
            text: `You were offline for ${hours}+ hours, so “${task.data.title}” went back to Ready for others. Call next_task when you're back.`,
            targetTaskId: task.recordId,
            createdBy: ops.userId,
            createdByName: 'Squadboard',
            deliveredAt: null,
          })
          await ops.log({ teamId: a.data.teamId, projectId: a.data.projectId, agentId: a.recordId, taskId: task.recordId, kind: 'agent', message: `released “${task.data.title}” from ${a.data.name} after ${hours}+ hours offline`, actorName: 'Squadboard' })
          await ops.recomputeOverlaps(a.data.teamId, a.data.projectId)
          released++
        }
      }
    }
  }
  return { offline, released }
}
