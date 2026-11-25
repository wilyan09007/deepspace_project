/**
 * Read-only GitHub access through the platform's `github/*` integration
 * (public repos only), billed to an explicit payer.
 *
 * The integration's response shapes are not documented, so every parser
 * below accepts the GitHub REST shape either at the top level or wrapped in
 * `data`/`result`, and fails with a clear message rather than guessing.
 */

import type { Env } from '../../../worker'
import { callIntegration, IntegrationError, type Payer } from './integration'

export interface RepoInfo {
  fullName: string
  defaultBranch: string
  description: string
  isPrivate: boolean
}

export type PrState = 'open' | 'closed' | 'merged'

export interface GitHubClient {
  getRepository(owner: string, repo: string): Promise<RepoInfo>
  /** Blob paths of the whole tree at `ref`. */
  getTree(owner: string, repo: string, ref: string): Promise<{ paths: string[]; truncated: boolean }>
  getReadme(owner: string, repo: string): Promise<string>
  /** File text, or null when missing / not a file / not decodable. */
  getFile(owner: string, repo: string, path: string, ref: string): Promise<string | null>
  getPullRequest(owner: string, repo: string, number: number): Promise<PrState>
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The object that actually carries GitHub's fields. */
export function unwrap(payload: unknown, probe: string): Obj {
  let cur: unknown = payload
  for (let i = 0; i < 3 && isObj(cur); i++) {
    if (probe in cur) return cur
    cur = cur.data ?? cur.result ?? cur.body
  }
  if (isObj(cur) && probe in cur) return cur
  throw new Error(`Unexpected GitHub response (no "${probe}")`)
}

export function decodeBase64Text(content: string): string {
  const bin = atob(content.replace(/\s+/g, ''))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/** File/readme payload → text (base64 per GitHub, or already-decoded text). */
export function parseFileContent(payload: unknown): string | null {
  if (typeof payload === 'string') return payload
  let obj: Obj
  try {
    obj = unwrap(payload, 'content')
  } catch {
    return null
  }
  if (obj.type && obj.type !== 'file') return null
  const content = obj.content
  if (typeof content !== 'string') return null
  if (obj.encoding === 'base64' || (obj.encoding === undefined && /^[A-Za-z0-9+/=\s]+$/.test(content) && content.length % 4 !== 1)) {
    try {
      return decodeBase64Text(content)
    } catch {
      return obj.encoding === 'base64' ? null : content
    }
  }
  return content
}

export function parseRepo(payload: unknown): RepoInfo {
  const o = unwrap(payload, 'default_branch')
  return {
    fullName: String(o.full_name ?? ''),
    defaultBranch: String(o.default_branch || 'main'),
    description: typeof o.description === 'string' ? o.description : '',
    isPrivate: o.private === true,
  }
}

export function parseTree(payload: unknown): { paths: string[]; truncated: boolean } {
  const o = unwrap(payload, 'tree')
  const tree = Array.isArray(o.tree) ? o.tree : []
  const paths = tree
    .filter((e): e is Obj => isObj(e) && (e.type === 'blob' || e.type === undefined) && typeof e.path === 'string')
    .map((e) => e.path as string)
  return { paths, truncated: o.truncated === true }
}

export function parsePr(payload: unknown): PrState {
  const o = unwrap(payload, 'state')
  if (o.merged === true || (typeof o.merged_at === 'string' && o.merged_at)) return 'merged'
  return o.state === 'closed' ? 'closed' : 'open'
}

export function githubClient(env: Env, payer: Payer): GitHubClient {
  const call = (endpoint: string, body: Obj) => callIntegration<unknown>(env, payer, `github/${endpoint}`, body)
  return {
    async getRepository(owner, repo) {
      return parseRepo(await call('get-repository', { owner, repo }))
    },
    async getTree(owner, repo, ref) {
      return parseTree(await call('get-repository-tree', { owner, repo, sha: ref, recursive: true }))
    },
    async getReadme(owner, repo) {
      try {
        return parseFileContent(await call('get-repository-readme', { owner, repo })) ?? ''
      } catch (e) {
        if (e instanceof IntegrationError && e.status === 404) return ''
        throw e
      }
    },
    async getFile(owner, repo, path, ref) {
      try {
        return parseFileContent(await call('get-repository-contents', { owner, repo, path, ref }))
      } catch (e) {
        if (e instanceof IntegrationError && e.status === 404) return null
        throw e
      }
    },
    async getPullRequest(owner, repo, number) {
      return parsePr(await call('get-pull-request', { owner, repo, pull_number: number }))
    },
  }
}
