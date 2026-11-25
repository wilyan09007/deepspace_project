/**
 * Squadboard's coordination engine — pure functions only (no I/O), so every
 * rule here is unit-tested in engine.test.ts.
 *
 * Model (decision #6 in docs/DECISIONS.md): there are no locks. Agents may
 * work on overlapping files; the engine's job is to (a) hand out work in an
 * order that keeps concurrent tasks apart, and (b) say exactly where active
 * work overlaps so agents and humans can coordinate.
 */

import { z } from 'zod/v4'

// ── Paths and imports ──────────────────────────────────────────────────────

export function normalizePath(path: string): string {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

const JS_EXT = /\.(m|c)?(t|j)sx?$/
const PY_EXT = /\.py$/

/** Raw import specifiers found in a source file (JS/TS and Python). */
export function parseImports(path: string, content: string): string[] {
  const specs = new Set<string>()
  if (JS_EXT.test(path) || /\.(vue|svelte|astro)$/.test(path)) {
    const patterns = [
      /\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"\n]+)['"]/g,
      /\bexport\s+(?:type\s+)?[\w*{}\s,$]*?\s+from\s+['"]([^'"\n]+)['"]/g,
      /\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g,
      /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    ]
    for (const re of patterns) for (const m of content.matchAll(re)) specs.add(m[1]!)
  } else if (PY_EXT.test(path)) {
    for (const m of content.matchAll(/^\s*from\s+([.\w]+)\s+import\s+/gm)) specs.add(m[1]!)
    for (const m of content.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) {
      for (const mod of m[1]!.split(',')) specs.add(mod.trim())
    }
  }
  return [...specs]
}

const JS_CANDIDATE_SUFFIXES = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.jsx',
]

/** Resolve an import specifier to a path in the repo, or null for packages / unknowns. */
export function resolveImport(fromPath: string, spec: string, repoPaths: ReadonlySet<string>): string | null {
  if (PY_EXT.test(fromPath)) return resolvePythonImport(fromPath, spec, repoPaths)

  let base: string | null = null
  if (spec.startsWith('./') || spec.startsWith('../')) base = normalizePath(`${dirname(fromPath)}/${spec}`)
  else if (spec.startsWith('@/')) base = normalizePath(`src/${spec.slice(2)}`)
  else if (spec.startsWith('~/')) base = normalizePath(`src/${spec.slice(2)}`)
  else if (spec.startsWith('/')) base = normalizePath(spec)
  if (base === null) return null

  // TS sources often import "./x.js" meaning "./x.ts".
  const stems = [base]
  if (/\.(m|c)?js$/.test(base)) stems.push(base.replace(/\.(m|c)?js$/, ''))
  for (const stem of stems) {
    for (const suffix of JS_CANDIDATE_SUFFIXES) {
      if (repoPaths.has(stem + suffix)) return stem + suffix
    }
  }
  return null
}

function resolvePythonImport(fromPath: string, spec: string, repoPaths: ReadonlySet<string>): string | null {
  let moduleParts: string[]
  let roots: string[]
  const leadingDots = spec.match(/^\.+/)?.[0].length ?? 0
  if (leadingDots > 0) {
    let dir = dirname(fromPath)
    for (let i = 1; i < leadingDots; i++) dir = dirname(dir)
    moduleParts = spec.slice(leadingDots).split('.').filter(Boolean)
    roots = [dir]
  } else {
    moduleParts = spec.split('.').filter(Boolean)
    roots = ['', 'src']
  }
  for (const root of roots) {
    const joined = [root, ...moduleParts].filter(Boolean).join('/')
    for (const candidate of [`${joined}.py`, `${joined}/__init__.py`]) {
      if (repoPaths.has(candidate)) return candidate
    }
  }
  return null
}

export type ImportEdges = Record<string, string[]>

/** file → repo files it imports, from the fetched source files only. */
export function buildImportEdges(
  files: ReadonlyArray<{ path: string; content: string }>,
  repoPaths: ReadonlySet<string>,
): ImportEdges {
  const edges: ImportEdges = {}
  for (const file of files) {
    const targets = new Set<string>()
    for (const spec of parseImports(file.path, file.content)) {
      const resolved = resolveImport(file.path, spec, repoPaths)
      if (resolved && resolved !== file.path) targets.add(resolved)
    }
    if (targets.size) edges[file.path] = [...targets].sort()
  }
  return edges
}

export function areNeighbors(a: string, b: string, edges: ImportEdges): boolean {
  return (edges[a]?.includes(b) ?? false) || (edges[b]?.includes(a) ?? false)
}

// ── Tasks and overlap ──────────────────────────────────────────────────────

export interface TaskLite {
  id: string
  title: string
  status: string
  order: number
  predictedFiles: string[]
  touchedFiles: string[]
  dependsOn: string[]
  agentId?: string | null
}

export const ACTIVE_STATUSES = new Set(['assigned', 'in_progress', 'blocked', 'paused', 'review'])

export function isActive(task: Pick<TaskLite, 'status'>): boolean {
  return ACTIVE_STATUSES.has(task.status)
}

export function taskFiles(task: Pick<TaskLite, 'predictedFiles' | 'touchedFiles'>): string[] {
  return [...new Set([...(task.predictedFiles ?? []), ...(task.touchedFiles ?? [])])]
}

export type OverlapKind = 'same-file' | 'import-neighbor'

export interface Overlap {
  key: string
  taskA: string
  taskB: string
  kind: OverlapKind
  /** For same-file: the shared files. For neighbors: "a.ts ↔ b.ts" pairs as [a, b, a2, b2, ...]. */
  files: string[]
}

export function overlapKey(taskA: string, taskB: string): string {
  return [taskA, taskB].sort().join('|')
}

/** How `task` overlaps each other task (same-file wins over neighbor). */
export function overlapsFor(task: TaskLite, others: readonly TaskLite[], edges: ImportEdges): Overlap[] {
  const mine = taskFiles(task)
  const result: Overlap[] = []
  for (const other of others) {
    if (other.id === task.id) continue
    const theirs = taskFiles(other)
    const shared = mine.filter((f) => theirs.includes(f))
    const [a, b] = [task.id, other.id].sort() as [string, string]
    if (shared.length) {
      result.push({ key: overlapKey(a, b), taskA: a, taskB: b, kind: 'same-file', files: shared.sort() })
      continue
    }
    const pairs: string[] = []
    for (const f of mine) for (const g of theirs) if (areNeighbors(f, g, edges)) pairs.push(f, g)
    if (pairs.length) result.push({ key: overlapKey(a, b), taskA: a, taskB: b, kind: 'import-neighbor', files: pairs })
  }
  return result
}

/** Every pairwise overlap among the active tasks of one project. */
export function detectOverlaps(tasks: readonly TaskLite[], edges: ImportEdges): Overlap[] {
  const active = tasks.filter(isActive)
  const seen = new Map<string, Overlap>()
  for (const task of active) {
    for (const o of overlapsFor(task, active, edges)) if (!seen.has(o.key)) seen.set(o.key, o)
  }
  return [...seen.values()]
}

export interface RankedTask {
  task: TaskLite
  score: number
  overlaps: Overlap[]
}

/**
 * Ready tasks whose dependencies are done, best first: least overlap with
 * work already in progress (same-file counts 3, neighbor 1), then plan order.
 */
export function rankReadyTasks(tasks: readonly TaskLite[], edges: ImportEdges): RankedTask[] {
  const done = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id))
  const active = tasks.filter(isActive)
  return tasks
    .filter((t) => t.status === 'ready' && t.dependsOn.every((d) => done.has(d)))
    .map((task) => {
      const overlaps = overlapsFor(task, active, edges)
      const score = overlaps.reduce((s, o) => s + (o.kind === 'same-file' ? 3 * o.files.length : 1), 0)
      return { task, score, overlaps }
    })
    .sort((x, y) => x.score - y.score || x.task.order - y.task.order)
}

// ── Plans ──────────────────────────────────────────────────────────────────

const MAX_TREE_PATHS = 600
const IGNORED_PATH =
  /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.git|\.next|\.turbo|__pycache__|\.venv|venv)(\/|$)|\.(lock|png|jpe?g|gif|webp|ico|svg|woff2?|ttf|eot|mp4|mp3|pdf|zip|gz|map|min\.js)$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i

/** Source-ish paths from a git tree, capped so the planner prompt stays small and cheap. */
export function filterTreePaths(paths: readonly string[]): { paths: string[]; truncated: boolean } {
  const kept = paths.filter((p) => !IGNORED_PATH.test(p))
  return { paths: kept.slice(0, MAX_TREE_PATHS), truncated: kept.length > MAX_TREE_PATHS }
}

export const MAX_PLAN_TASKS = 10
const MAX_FILES_PER_TASK = 12

export const rawPlanSchema = z.object({
  summary: z.string().max(600).optional(),
  tasks: z
    .array(
      z.object({
        title: z.string().min(3).max(140),
        body: z.string().max(2000).default(''),
        acceptance: z.string().max(600).default(''),
        files: z.array(z.string().max(300)).max(40).default([]),
        dependsOn: z.array(z.number().int()).max(10).default([]),
      }),
    )
    .min(1)
    .max(25),
})

export interface PlannedTask {
  title: string
  body: string
  acceptance: string
  predictedFiles: string[]
  /** Indices into the plan's task list; always earlier tasks, so no cycles. */
  dependsOn: number[]
}

export interface ValidatedPlan {
  summary: string
  tasks: PlannedTask[]
  droppedFiles: string[]
}

/**
 * Turn model output into a plan we can trust: known files only (or a new file
 * inside an existing directory), dependencies only on earlier tasks, capped
 * task and file counts.
 */
export function validatePlan(raw: unknown, repoPaths: ReadonlySet<string>): ValidatedPlan {
  const parsed = rawPlanSchema.parse(raw)
  const dirs = new Set<string>([''])
  for (const p of repoPaths) {
    let d = dirname(p)
    while (d && !dirs.has(d)) {
      dirs.add(d)
      d = dirname(d)
    }
  }
  const dropped: string[] = []
  const tasks = parsed.tasks.slice(0, MAX_PLAN_TASKS).map((t, index) => {
    const files: string[] = []
    for (const f of t.files) {
      const path = normalizePath(f)
      if (!path || files.includes(path)) continue
      if (repoPaths.has(path) || dirs.has(dirname(path))) files.push(path)
      else dropped.push(path)
    }
    return {
      title: t.title.trim(),
      body: t.body.trim(),
      acceptance: t.acceptance.trim(),
      predictedFiles: files.slice(0, MAX_FILES_PER_TASK),
      dependsOn: [...new Set(t.dependsOn)].filter((d) => d >= 0 && d < index),
    }
  })
  return { summary: parsed.summary?.trim() ?? '', tasks, droppedFiles: dropped }
}

/** Pull the first JSON object out of a model reply (tolerates ```json fences and prose). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1]! : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('No JSON object in model reply')
  return JSON.parse(candidate.slice(start, end + 1))
}

/** Files worth fetching to learn import edges: predicted files that exist, parsable, capped. */
export function filesToInspect(plan: ValidatedPlan, repoPaths: ReadonlySet<string>, cap = 12): string[] {
  const counts = new Map<string, number>()
  for (const t of plan.tasks) {
    for (const f of t.predictedFiles) {
      if (repoPaths.has(f) && (JS_EXT.test(f) || PY_EXT.test(f))) counts.set(f, (counts.get(f) ?? 0) + 1)
    }
  }
  // Files shared by several tasks matter most for overlap.
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, cap)
    .map(([f]) => f)
}

// ── Misc helpers ───────────────────────────────────────────────────────────

/** Parse "owner/repo", a github.com URL, or a git remote into its parts. */
export function parseRepoRef(input: string): { owner: string; repo: string } | null {
  const trimmed = input.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  const m =
    trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+)/i) ??
    trimmed.match(/^git@github\.com:([\w.-]+)\/([\w.-]+)$/i) ??
    trimmed.match(/^([\w.-]+)\/([\w.-]+)$/)
  if (!m) return null
  return { owner: m[1]!, repo: m[2]! }
}

/** Parse a GitHub PR URL. */
export function parsePrUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.trim().match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/)
  return m ? { owner: m[1]!, repo: m[2]!, number: Number(m[3]) } : null
}

/** Clean an agent-supplied file list: repo-relative, deduped, capped. */
export function cleanFileList(files: unknown, cap = 50): string[] {
  if (!Array.isArray(files)) return []
  const out: string[] = []
  for (const f of files) {
    if (typeof f !== 'string') continue
    const p = normalizePath(f.trim())
    if (p && p.length <= 300 && !out.includes(p)) out.push(p)
    if (out.length >= cap) break
  }
  return out
}

/** Fixed-window bucket id, e.g. a calendar day in UTC. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}
