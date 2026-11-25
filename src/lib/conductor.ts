/**
 * Display helpers for Conductor records. Row shapes come from the server's
 * ops.ts (type-only import — no server code reaches the browser).
 */

export type {
  Agent,
  Directive,
  EventRow,
  Goal,
  Member,
  OverlapRow,
  Project,
  Question,
  Task,
  Team,
} from '@/server/core/ops'
export type { Digest } from '@/server/core/digest'

export const TASK_STATUS: Record<string, { label: string; tone: string }> = {
  ready: { label: 'Ready', tone: 'text-st-ready' },
  assigned: { label: 'Assigned', tone: 'text-st-working' },
  in_progress: { label: 'Working', tone: 'text-st-working' },
  blocked: { label: 'Blocked', tone: 'text-st-blocked' },
  paused: { label: 'Paused', tone: 'text-st-paused' },
  review: { label: 'Checking', tone: 'text-st-review' },
  done: { label: 'Done', tone: 'text-st-done' },
}

export const AGENT_STATUS: Record<string, { label: string; dot: string }> = {
  idle: { label: 'Idle', dot: 'bg-st-ready' },
  working: { label: 'Working', dot: 'bg-st-working' },
  paused: { label: 'Paused', dot: 'bg-st-paused' },
  offline: { label: 'Offline', dot: 'bg-muted-foreground/40' },
}

export const GOAL_STATUS: Record<string, string> = {
  planning: 'Planning…',
  planned: 'Planned',
  active: 'In progress',
  done: 'Done',
  failed: 'Planning failed',
}

/** Board columns: which task statuses land in which column. */
export const COLUMNS = [
  { id: 'ready', title: 'Ready', statuses: ['ready'] },
  { id: 'active', title: 'In progress', statuses: ['assigned', 'in_progress', 'review', 'blocked'] },
  { id: 'paused', title: 'Paused', statuses: ['paused'] },
  { id: 'done', title: 'Done', statuses: ['done'] },
] as const

export function timeAgo(ms: number | string | undefined, now = Date.now()): string {
  if (!ms) return 'never'
  const t = typeof ms === 'string' ? Date.parse(ms) : ms
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

export const repoUrl = (p: { repoOwner: string; repoName: string }) => `https://github.com/${p.repoOwner}/${p.repoName}`

/** Only github.com links are rendered as links (agents write these). */
export function safeGithubUrl(url: string | null | undefined): string | null {
  if (!url) return null
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\/pull\/\d+)?$/.test(url) ? url : null
}
