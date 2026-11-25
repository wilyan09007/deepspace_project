/**
 * Live GitHub updates (decision #24): GitHub pushes issue and pull request events to
 * /api/github/webhook/<projectId> as they happen, so closing an issue or merging a PR updates the
 * board at once instead of when someone next opens it.
 *
 * Every delivery is signed with the project's secret (HMAC-SHA256 in X-Hub-Signature-256), which
 * only the server holds (github_webhooks is server-only). A missing or wrong signature and an
 * unknown project get the same 401. Signed events about another repository are ignored. Events are
 * read back through the same code as a sync (readIssue / readPull), so the same rules apply: a task
 * only answers to its own issue, and only a merged PR approves a task. Webhooks arrive with no
 * signed-in user, so nothing here acts on GitHub; pushing Squadboard's changes out (mirrored issue
 * labels and state) still happens in a sync, which acts as a member.
 *
 * A replayed delivery re-applies an event that already happened, which changes nothing (a done task
 * stays done), so deliveries aren't de-duplicated.
 */

import { readIssue, readPull, refreshItem, taskIndex, type WebhookRow } from './github-sync'
import { toIssue, toPull } from './github-user'
import type { Ops, Project } from './ops'

/** Issue and PR events are a few KB; anything this big isn't one. */
export const MAX_WEBHOOK_BYTES = 1_000_000

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const enc = new TextEncoder()

const hmacKey = (secret: string) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])

/** The X-Hub-Signature-256 value GitHub sends for `body` (also used by tests). */
export async function signGithubPayload(secret: string, body: string): Promise<string> {
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)))
  return `sha256=${[...sig].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

/** Whether `signature` (the X-Hub-Signature-256 header) signs `body` with `secret`. Compared in constant time. */
export async function verifyGithubSignature(secret: string, body: string, signature: string): Promise<boolean> {
  const hex = /^sha256=([0-9a-f]{64})$/i.exec(signature ?? '')?.[1]
  if (!secret || !hex) return false
  const bytes = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)))
  return crypto.subtle.verify('HMAC', await hmacKey(secret), bytes, enc.encode(body))
}

export interface WebhookDelivery {
  /** The X-GitHub-Event header. */
  event: string
  /** The X-Hub-Signature-256 header. */
  signature: string
  /** The raw request body, exactly as received (the signature covers these bytes). */
  body: string
}

export interface WebhookReply {
  status: 200 | 400 | 401 | 413
  body: { handled?: string; error?: string }
}

const ignored: WebhookReply = { status: 200, body: { handled: 'ignored' } }

/** Check a delivery's signature and apply it. `ops` acts as the app (no member): access comes from the signature. */
export async function receiveGithubWebhook(ops: Ops, projectId: string, delivery: WebhookDelivery): Promise<WebhookReply> {
  if (delivery.body.length > MAX_WEBHOOK_BYTES) return { status: 413, body: { error: 'Payload too large' } }
  const [hook] = projectId ? await ops.store.query<WebhookRow>('github_webhooks', { projectId }) : []
  if (!hook || !(await verifyGithubSignature(hook.data.secret, delivery.body, delivery.signature))) {
    return { status: 401, body: { error: 'Invalid signature' } }
  }
  let payload: unknown
  try {
    payload = JSON.parse(delivery.body)
  } catch {
    return { status: 400, body: { error: 'Invalid JSON' } }
  }
  if (!isObj(payload)) return { status: 400, body: { error: 'Invalid JSON' } }

  const project = await ops.store.get<Project>('projects', projectId)
  if (!project || project.data.kind !== 'repo') return ignored
  const repo = isObj(payload.repository) ? String(payload.repository.full_name ?? '') : ''
  if (repo.toLowerCase() !== `${project.data.repoOwner}/${project.data.repoName}`.toLowerCase()) return ignored
  await ops.store.update<Project>('projects', projectId, { ghWebhookAt: ops.now() })

  if (delivery.event === 'issues' && isObj(payload.issue) && !payload.issue.pull_request) {
    const issue = toIssue(payload.issue)
    const index = await taskIndex(ops, projectId)
    await readIssue(ops, index, issue)
    await refreshItem(ops, project, 'issue', issue, index.byIssue.get(issue.number)?.recordId ?? '')
    return { status: 200, body: { handled: 'issue' } }
  }
  if (delivery.event === 'pull_request' && isObj(payload.pull_request)) {
    const pr = toPull(payload.pull_request)
    const { linked } = await readPull(ops, await taskIndex(ops, projectId), pr)
    await refreshItem(ops, project, 'pr', pr, linked[linked.length - 1] ?? '')
    return { status: 200, body: { handled: 'pull_request' } }
  }
  return { status: 200, body: { handled: delivery.event === 'ping' ? 'ping' : 'ignored' } }
}
