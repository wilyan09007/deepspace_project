/**
 * GitHub through the signed-in user's own GitHub connection (Composio),
 * acting as that user and billed to them (decisions #19, #20). Reads work on
 * private repos the user can see; writes (issues, labels, comments) appear on
 * GitHub as that user.
 *
 * When the user hasn't connected GitHub, Composio answers with a
 * `requiresConnection` signal; this module throws `GithubNotConnected` so
 * callers can fall back to the public reader or ask the user to connect.
 */

import type { Env } from '../../../worker'
import { parseFileContent, parsePr, parseRepo, parseTree, type GitHubClient, type PrState } from './github'
import { callIntegration } from './integration'

export class GithubNotConnected extends Error {
  constructor() {
    super('Connect your GitHub account to Squadboard first')
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

export interface IssueSummary {
  number: number
  title: string
  url: string
  state: 'open' | 'closed'
  body: string
  labels: string[]
  author: string
  updatedAt: string
}

export interface PullSummary extends IssueSummary {
  merged: boolean
}

export interface GitHubWriter {
  /** The user's access to the repo. */
  permission(owner: string, repo: string): Promise<'admin' | 'write' | 'read' | 'none'>
  ensureLabel(owner: string, repo: string, name: string, color: string, description: string): Promise<void>
  createIssue(owner: string, repo: string, issue: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }>
  updateIssue(owner: string, repo: string, number: number, patch: { body?: string; labels?: string[]; state?: 'open' | 'closed'; state_reason?: string }): Promise<void>
  comment(owner: string, repo: string, number: number, body: string): Promise<void>
  listIssues(owner: string, repo: string): Promise<IssueSummary[]>
  listPulls(owner: string, repo: string): Promise<PullSummary[]>
  /** Add a repository webhook (GitHub requires admin access to the repo). */
  createWebhook(owner: string, repo: string, hook: { url: string; secret: string; events: string[] }): Promise<{ id: number }>
}

/** Find the GitHub payload inside Composio's envelope(s). */
export function composioData(payload: unknown): unknown {
  let cur: unknown = payload
  for (let i = 0; i < 4 && isObj(cur); i++) {
    if (cur.requiresConnection === true) throw new GithubNotConnected()
    if (cur.successful === false || cur.success === false) {
      throw new Error(String(cur.error ?? 'GitHub request failed'))
    }
    if ('data' in cur && (isObj(cur.data) || Array.isArray(cur.data))) cur = cur.data
    else if ('response_data' in cur) cur = cur.response_data
    else break
  }
  return cur
}

function list(payload: unknown, key: string): Obj[] {
  const d = composioData(payload)
  if (Array.isArray(d)) return d.filter(isObj)
  if (isObj(d)) {
    for (const k of [key, 'items', 'details', 'data']) {
      const v = d[k]
      if (Array.isArray(v)) return v.filter(isObj)
    }
  }
  return []
}

/** A PR as GitHub's REST API and webhooks describe it. */
export function toPull(o: Obj): PullSummary {
  return { ...toIssue(o), merged: Boolean(o.merged_at) || o.merged === true }
}

/** An issue (or PR) as GitHub's REST API and webhooks describe it. */
export function toIssue(o: Obj): IssueSummary {
  const user = isObj(o.user) ? o.user : {}
  return {
    number: Number(o.number),
    title: String(o.title ?? ''),
    url: String(o.html_url ?? ''),
    state: o.state === 'closed' ? 'closed' : 'open',
    body: typeof o.body === 'string' ? o.body : '',
    labels: Array.isArray(o.labels) ? o.labels.map((l) => (isObj(l) ? String(l.name ?? '') : String(l))).filter(Boolean) : [],
    author: String(user.login ?? ''),
    updatedAt: String(o.updated_at ?? ''),
  }
}

export function userGithub(env: Env, jwt: string): GitHubClient & GitHubWriter {
  const run = async (slug: string, args: Obj): Promise<unknown> => {
    const out = await callIntegration<unknown>(env, { kind: 'user', jwt }, 'composio/execute-tool', { slug, arguments: args })
    return composioData(out)
  }
  return {
    async getRepository(owner, repo) {
      return parseRepo(await run('GITHUB_GET_A_REPOSITORY', { owner, repo }))
    },
    async getTree(owner, repo, ref) {
      return parseTree(await run('GITHUB_GET_A_TREE', { owner, repo, tree_sha: ref, recursive: 'true' }))
    },
    async getReadme(owner, repo) {
      try {
        return parseFileContent(await run('GITHUB_GET_A_REPOSITORY_README', { owner, repo })) ?? ''
      } catch (e) {
        if (e instanceof GithubNotConnected) throw e
        return ''
      }
    },
    async getFile(owner, repo, path, ref) {
      try {
        const d = await run('GITHUB_GET_REPOSITORY_CONTENT', { owner, repo, path, ref })
        if (typeof d === 'string') return d
        return parseFileContent(d)
      } catch (e) {
        if (e instanceof GithubNotConnected) throw e
        return null
      }
    },
    async getPullRequest(owner, repo, number): Promise<PrState> {
      return parsePr(await run('GITHUB_GET_A_PULL_REQUEST', { owner, repo, pull_number: number }))
    },
    async permission(owner, repo) {
      const d = await run('GITHUB_GET_A_REPOSITORY', { owner, repo })
      const perms = isObj(d) && isObj(d.permissions) ? d.permissions : {}
      if (perms.admin) return 'admin'
      if (perms.maintain || perms.push) return 'write'
      if (perms.pull || perms.triage) return 'read'
      return 'none'
    },
    async ensureLabel(owner, repo, name, color, description) {
      try {
        await run('GITHUB_CREATE_A_LABEL', { owner, repo, name, color, description })
      } catch (e) {
        if (e instanceof GithubNotConnected) throw e
        // Already exists (422) is fine.
      }
    },
    async createIssue(owner, repo, issue) {
      const d = await run('GITHUB_CREATE_AN_ISSUE', { owner, repo, ...issue })
      const o = isObj(d) ? d : {}
      if (!o.number) throw new Error('GitHub did not return the new issue')
      return { number: Number(o.number), url: String(o.html_url ?? '') }
    },
    async updateIssue(owner, repo, number, patch) {
      await run('GITHUB_UPDATE_AN_ISSUE', { owner, repo, issue_number: number, ...patch })
    },
    async comment(owner, repo, number, body) {
      await run('GITHUB_CREATE_AN_ISSUE_COMMENT', { owner, repo, issue_number: number, body })
    },
    async listIssues(owner, repo) {
      const items = list(await run('GITHUB_LIST_REPOSITORY_ISSUES', { owner, repo, state: 'all', sort: 'updated', direction: 'desc', per_page: 100 }), 'issues')
      return items.filter((o) => !o.pull_request).map(toIssue)
    },
    async listPulls(owner, repo) {
      const items = list(await run('GITHUB_LIST_PULL_REQUESTS', { owner, repo, state: 'all', sort: 'updated', direction: 'desc', per_page: 50 }), 'pull_requests')
      return items.map(toPull)
    },
    async createWebhook(owner, repo, hook) {
      const d = await run('GITHUB_CREATE_A_REPOSITORY_WEBHOOK', {
        owner,
        repo,
        active: true,
        events: hook.events,
        config: { url: hook.url, content_type: 'json', secret: hook.secret, insecure_ssl: '0' },
      })
      const o = isObj(d) ? d : {}
      if (!o.id) throw new Error('GitHub did not return the new webhook')
      return { id: Number(o.id) }
    },
  }
}

/** Whether the user has an active GitHub connection in this app. */
export async function githubConnection(env: Env, jwt: string): Promise<{ connected: boolean }> {
  const out = await callIntegration<unknown>(env, { kind: 'user', jwt }, 'composio/list-connections', { toolkit: 'github', status: 'ACTIVE' })
  const conns = isObj(out) && Array.isArray(out.connections) ? out.connections : Array.isArray(out) ? out : []
  return { connected: conns.length > 0 }
}

/** Start connecting GitHub: returns the hosted consent page to send the user to. */
export async function startGithubConnection(env: Env, jwt: string, callbackUrl: string): Promise<{ url: string }> {
  const out = await callIntegration<unknown>(env, { kind: 'user', jwt }, 'composio/initiate-connection', { toolkit: 'github', callbackUrl })
  const o = isObj(out) ? out : {}
  const url = [o.redirectUrl, o.redirect_url, o.url, o.consentUrl, isObj(o.connection) ? o.connection.redirectUrl : undefined].find(
    (v): v is string => typeof v === 'string' && /^https:\/\//.test(v),
  )
  if (!url) throw new Error('GitHub connection could not be started')
  return { url }
}

/** Reads through the user's connection when they have one, else the public reader. */
export function preferUserGithub(user: GitHubClient, publicReader: GitHubClient): GitHubClient {
  let useUser = true
  const pick = <K extends keyof GitHubClient>(k: K) =>
    (async (...args: unknown[]) => {
      if (useUser) {
        try {
          return await (user[k] as (...a: unknown[]) => Promise<unknown>)(...args)
        } catch (e) {
          if (!(e instanceof GithubNotConnected)) throw e
          useUser = false
        }
      }
      return (publicReader[k] as (...a: unknown[]) => Promise<unknown>)(...args)
    }) as GitHubClient[K]
  return {
    getRepository: pick('getRepository'),
    getTree: pick('getTree'),
    getReadme: pick('getReadme'),
    getFile: pick('getFile'),
    getPullRequest: pick('getPullRequest'),
  }
}

