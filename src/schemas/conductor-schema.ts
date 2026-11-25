/**
 * Squadboard collections.
 *
 * Access model: every team-owned row carries `teamId` and uses the SDK's
 * built-in `'team'` permission level, which resolves membership against the
 * `team_members` collection below. Clients only READ these collections; every
 * write goes through server code (src/server/core/ops.ts) reached from a
 * server action, an agent tool, a job, or cron. That code checks team
 * membership itself before writing, so no client can forge an assignment,
 * a directive, or someone else's membership row.
 */

import type { CollectionSchema, ColumnDefinition } from 'deepspace/schema'

const text = (name: string): ColumnDefinition => ({ name, storage: 'text', interpretation: 'plain' })
const json = (name: string): ColumnDefinition => ({
  name,
  storage: 'text',
  interpretation: { kind: 'json' },
})
const num = (name: string): ColumnDefinition => ({ name, storage: 'number', interpretation: 'plain' })
const select = (name: string, options: string[]): ColumnDefinition => ({
  name,
  storage: 'text',
  interpretation: { kind: 'select', options },
})

/** Read for team members, nothing else for anyone; admins (app owner) see all. */
const TEAM_READ_ONLY: CollectionSchema['permissions'] = {
  viewer: { read: false, create: false, update: false, delete: false },
  member: { read: 'team', create: false, update: false, delete: false },
  admin: { read: true, create: false, update: false, delete: false },
}

/** Server-only bookkeeping: no client can read or write it. */
const SERVER_ONLY: CollectionSchema['permissions'] = {
  viewer: { read: false, create: false, update: false, delete: false },
  member: { read: false, create: false, update: false, delete: false },
  admin: { read: true, create: false, update: false, delete: false },
}

export const TASK_STATUSES = [
  'ready',
  'assigned',
  'in_progress',
  'blocked',
  'paused',
  'review',
  'done',
] as const
export const AGENT_STATUSES = ['idle', 'working', 'paused', 'offline'] as const
export const GOAL_STATUSES = ['planning', 'planned', 'active', 'done', 'failed'] as const
export const DIRECTIVE_KINDS = ['pause', 'resume', 'reassign', 'answer', 'note'] as const
export const EVENT_KINDS = [
  'team',
  'plan',
  'assign',
  'check_in',
  'question',
  'answer',
  'directive',
  'overlap',
  'complete',
  'agent',
  'demo',
  'review',
  'github',
] as const

export const conductorSchemas: CollectionSchema[] = [
  {
    // `teamId` equals the record id so the built-in team rule covers the row itself.
    name: 'teams',
    columns: [text('teamId'), text('name'), text('ownerId'), num('lastActivityAt')],
    teamField: 'teamId',
    permissions: TEAM_READ_ONLY,
  },
  {
    // Built-in membership table for the 'team' permission level.
    name: 'team_members',
    columns: [
      text('teamId'),
      text('userId'),
      select('status', ['active', 'removed']),
      select('role', ['owner', 'member']),
      text('userName'),
      text('userImage'),
      // Unused since decision #18 (digest emails are on demand); kept so existing rows stay valid.
      num('digestOptIn'),
    ],
    teamField: 'teamId',
    uniqueOn: ['teamId', 'userId'],
    permissions: TEAM_READ_ONLY,
  },
  {
    name: 'team_invites',
    columns: [text('teamId'), text('code'), text('createdBy'), num('expiresAt'), text('usedBy')],
    teamField: 'teamId',
    uniqueOn: ['code'],
    permissions: TEAM_READ_ONLY,
  },
  {
    name: 'projects',
    columns: [
      text('teamId'),
      text('repoOwner'),
      text('repoName'),
      text('defaultBranch'),
      text('description'),
      select('kind', ['repo', 'sample']),
      // Last user-triggered PR status refresh (decision #17 throttle).
      num('prCheckedAt'),
      // GitHub sync (decision #19): 1 = mirror tasks as issues; who turned it on; last sync.
      num('mirrorIssues'),
      text('mirrorBy'),
      num('ghSyncedAt'),
      text('ghSyncError'),
      // Live updates over a GitHub webhook: how it was added ('auto' | 'manual'), last delivery.
      text('ghWebhook'),
      num('ghWebhookAt'),
    ],
    teamField: 'teamId',
    permissions: TEAM_READ_ONLY,
  },
  {
    name: 'goals',
    columns: [
      text('teamId'),
      text('projectId'),
      text('title'),
      text('body'),
      select('status', [...GOAL_STATUSES]),
      text('planStage'),
      text('planError'),
      text('planModel'),
      json('importEdges'),
      text('createdByName'),
      select('source', ['planner', 'sample']),
      // Demo run state: 'running' | 'stopping' | 'stopped' | '' (never run).
      text('demoState'),
      text('planSummary'),
      // Set when the goal was planned from a GitHub issue.
      num('sourceIssueNumber'),
      text('sourceIssueUrl'),
    ],
    teamField: 'teamId',
    permissions: TEAM_READ_ONLY,
  },
  {
    name: 'tasks',
    columns: [
      text('teamId'),
      text('projectId'),
      text('goalId'),
      text('title'),
      text('body'),
      text('acceptance'),
      json('predictedFiles'),
      json('dependsOn'),
      num('order'),
      select('status', [...TASK_STATUSES]),
      text('agentId'),
      json('touchedFiles'),
      text('lastSummary'),
      text('prUrl'),
      text('prState'),
      num('updatedAtMs'),
      // GitHub mirror: the task's issue and the status last written to it.
      num('issueNumber'),
      text('issueUrl'),
      text('ghStatus'),
      // Review gate and handoff: who last held it, review note, merge alert sent.
      text('lastAgentId'),
      text('reviewNote'),
      num('mergeAlerted'),
    ],
    teamField: 'teamId',
    permissions: TEAM_READ_ONLY,
  },
  {
    // One row per task an agent holds. uniqueOn makes the claim atomic: when two
    // agents race for the same task, the room rejects the second insert.
    name: 'task_claims',
    columns: [text('teamId'), text('taskId'), text('agentId')],
    teamField: 'teamId',
    uniqueOn: ['taskId'],
    permissions: TEAM_READ_ONLY,
  },
  {
    name: 'agents',
    columns: [
      text('teamId'),
      text('projectId'),
      text('name'),
      text('ownerUserId'),
      text('ownerName'),
      select('kind', ['cli', 'demo']),
      select('status', [...AGENT_STATUSES]),
      text('currentTaskId'),
      num('lastSeenAt'),
      text('lastSummary'),
    ],
    teamField: 'teamId',
    uniqueOn: ['projectId', 'ownerUserId', 'name'],
    permissions: TEAM_READ_ONLY,
  },
  {
    name: 'directives',
    columns: [
      text('teamId'),
      text('agentId'),
      select('kind', [...DIRECTIVE_KINDS]),
      text('text'),
      text('targetTaskId'),
      text('createdBy'),
      text('createdByName'),
      num('deliveredAt'),
    ],
    teamField: 'teamId',
    permissions: TEAM_READ_ONLY,
  },
  {
    name: 'questions',
    columns: [
      text('teamId'),
      text('projectId'),
      text('agentId'),
      text('taskId'),
      text('text'),
      text('answer'),
      text('answeredByName'),
      select('status', ['open', 'answered']),
    ],
    teamField: 'teamId',
    permissions: TEAM_READ_ONLY,
  },
  {
    name: 'overlaps',
    columns: [
      text('teamId'),
      text('projectId'),
      text('key'),
      text('taskA'),
      text('taskB'),
      json('files'),
      select('kind', ['same-file', 'import-neighbor']),
      select('status', ['open', 'acknowledged', 'resolved']),
    ],
    teamField: 'teamId',
    uniqueOn: ['key'],
    permissions: TEAM_READ_ONLY,
  },
  {
    name: 'events',
    columns: [
      text('teamId'),
      text('projectId'),
      text('agentId'),
      text('taskId'),
      select('kind', [...EVENT_KINDS]),
      text('message'),
      json('files'),
      text('actorName'),
      num('at'),
    ],
    teamField: 'teamId',
    permissions: TEAM_READ_ONLY,
  },
  {
    name: 'digests',
    columns: [text('teamId'), text('date'), text('body'), json('sentTo')],
    teamField: 'teamId',
    uniqueOn: ['teamId', 'date'],
    permissions: TEAM_READ_ONLY,
  },
  {
    // Open issues and PRs read from GitHub during a sync, for the board's GitHub panel.
    name: 'github_items',
    columns: [
      text('teamId'),
      text('projectId'),
      text('key'),
      select('kind', ['issue', 'pr']),
      num('number'),
      text('title'),
      text('url'),
      text('state'),
      text('author'),
      text('linkedTaskId'),
      num('merged'),
      text('updatedAtGh'),
      text('body'),
    ],
    teamField: 'teamId',
    uniqueOn: ['key'],
    permissions: TEAM_READ_ONLY,
  },
  {
    // The assistant's pending action awaiting the user's explicit "yes" (one per user).
    name: 'assistant_proposals',
    columns: [text('userId'), text('agentId'), text('kind'), text('text'), text('summary'), num('createdAt'), num('expiresAt')],
    uniqueOn: ['userId'],
    permissions: SERVER_ONLY,
  },
  {
    // A project's GitHub webhook: the secret GitHub signs deliveries with. Server-only: anyone holding
    // the secret could forge events for the project.
    name: 'github_webhooks',
    columns: [text('teamId'), text('projectId'), text('secret'), num('hookId'), num('createdAt')],
    uniqueOn: ['projectId'],
    permissions: SERVER_ONLY,
  },
  {
    // Rate-limit counters: key = `<bucket>:<subject>:<window>`.
    name: 'usage_counters',
    columns: [text('key'), num('count')],
    uniqueOn: ['key'],
    permissions: SERVER_ONLY,
  },
]
