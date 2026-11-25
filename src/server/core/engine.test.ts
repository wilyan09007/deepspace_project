import { describe, expect, it } from 'vitest'
import {
  buildImportEdges,
  cleanFileList,
  detectOverlaps,
  extractJson,
  filesToInspect,
  filterTreePaths,
  overlapsFor,
  parseImports,
  parsePrUrl,
  parseRepoRef,
  rankReadyTasks,
  resolveImport,
  validatePlan,
  type TaskLite,
} from './engine'

const repo = new Set([
  'src/auth/session.ts',
  'src/auth/index.ts',
  'src/api/users.ts',
  'src/api/billing.ts',
  'src/ui/Settings.tsx',
  'src/lib/util.js',
  'app/models.py',
  'app/views.py',
  'app/__init__.py',
  'README.md',
])

function task(id: string, patch: Partial<TaskLite> = {}): TaskLite {
  return {
    id,
    title: id,
    status: 'ready',
    order: Number(id.replace(/\D/g, '')) || 0,
    predictedFiles: [],
    touchedFiles: [],
    dependsOn: [],
    ...patch,
  }
}

describe('parseImports / resolveImport', () => {
  it('finds ES, re-export, require and dynamic imports', () => {
    const src = `
      import { a } from './a'
      import type { T } from "../types"
      import './side-effect'
      export * from './re'
      const x = require('./cjs')
      const y = await import('./lazy')
      import React from 'react'`
    expect(parseImports('src/x.ts', src).sort()).toEqual(
      ['../types', './a', './cjs', './lazy', './re', './side-effect', 'react'].sort(),
    )
  })

  it('resolves relative, index, .js-for-.ts and @/ alias imports; ignores packages', () => {
    expect(resolveImport('src/api/users.ts', '../auth/session', repo)).toBe('src/auth/session.ts')
    expect(resolveImport('src/api/users.ts', '../auth', repo)).toBe('src/auth/index.ts')
    expect(resolveImport('src/api/users.ts', '../auth/session.js', repo)).toBe('src/auth/session.ts')
    expect(resolveImport('src/ui/Settings.tsx', '@/api/billing', repo)).toBe('src/api/billing.ts')
    expect(resolveImport('src/api/users.ts', 'react', repo)).toBeNull()
    expect(resolveImport('src/api/users.ts', './missing', repo)).toBeNull()
  })

  it('resolves Python absolute and relative imports', () => {
    expect(parseImports('app/views.py', 'from .models import User\nimport os, app.models')).toEqual(
      expect.arrayContaining(['.models', 'os', 'app.models']),
    )
    expect(resolveImport('app/views.py', '.models', repo)).toBe('app/models.py')
    expect(resolveImport('app/views.py', 'app.models', repo)).toBe('app/models.py')
    expect(resolveImport('app/views.py', 'app', repo)).toBe('app/__init__.py')
    expect(resolveImport('app/views.py', 'os', repo)).toBeNull()
  })

  it('builds edges only to repo files', () => {
    const edges = buildImportEdges(
      [{ path: 'src/api/users.ts', content: "import { s } from '../auth/session'\nimport z from 'zod'" }],
      repo,
    )
    expect(edges).toEqual({ 'src/api/users.ts': ['src/auth/session.ts'] })
  })
})

describe('overlap', () => {
  const edges = { 'src/api/users.ts': ['src/auth/session.ts'] }

  it('reports shared files first and import neighbors otherwise', () => {
    const a = task('t1', { status: 'in_progress', predictedFiles: ['src/api/users.ts'] })
    const b = task('t2', { status: 'in_progress', touchedFiles: ['src/api/users.ts', 'README.md'] })
    const c = task('t3', { status: 'in_progress', predictedFiles: ['src/auth/session.ts'] })
    const d = task('t4', { status: 'in_progress', predictedFiles: ['src/ui/Settings.tsx'] })
    const found = detectOverlaps([a, b, c, d], edges)
    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 't1|t2', kind: 'same-file', files: ['src/api/users.ts'] }),
        expect.objectContaining({ key: 't1|t3', kind: 'import-neighbor' }),
        expect.objectContaining({ key: 't2|t3', kind: 'import-neighbor' }),
      ]),
    )
    expect(found.some((o) => o.key.includes('t4'))).toBe(false)
  })

  it('ignores tasks that are not active', () => {
    const a = task('t1', { status: 'in_progress', predictedFiles: ['README.md'] })
    const b = task('t2', { status: 'done', predictedFiles: ['README.md'] })
    expect(detectOverlaps([a, b], {})).toEqual([])
    expect(overlapsFor(a, [b], {})).toHaveLength(1) // direct comparison still works
  })
})

describe('rankReadyTasks', () => {
  it('skips tasks with unfinished dependencies and prefers the least overlap', () => {
    const working = task('t1', { status: 'in_progress', predictedFiles: ['src/api/users.ts'] })
    const clash = task('t2', { predictedFiles: ['src/api/users.ts'] })
    const neighbor = task('t3', { predictedFiles: ['src/auth/session.ts'] })
    const free = task('t4', { predictedFiles: ['src/ui/Settings.tsx'] })
    const blocked = task('t5', { dependsOn: ['t1'] })
    const ranked = rankReadyTasks([working, clash, neighbor, free, blocked], {
      'src/api/users.ts': ['src/auth/session.ts'],
    })
    expect(ranked.map((r) => r.task.id)).toEqual(['t4', 't3', 't2'])
    expect(ranked[2]!.overlaps[0]!.kind).toBe('same-file')
  })

  it('releases a dependent once its dependency is done', () => {
    const ranked = rankReadyTasks([task('t1', { status: 'done' }), task('t2', { dependsOn: ['t1'] })], {})
    expect(ranked.map((r) => r.task.id)).toEqual(['t2'])
  })
})

describe('plans', () => {
  it('keeps known files and new files in known dirs, drops the rest, and fixes dependencies', () => {
    const plan = validatePlan(
      {
        summary: 'Add dark mode',
        tasks: [
          { title: 'Theme tokens', files: ['./src/ui/Settings.tsx', 'src/ui/theme.css', 'nope/x.ts'], dependsOn: [0, 3] },
          { title: 'Persist choice', files: ['src/api/users.ts'], dependsOn: [0, 1, -1] },
        ],
      },
      repo,
    )
    expect(plan.tasks[0]!.predictedFiles).toEqual(['src/ui/Settings.tsx', 'src/ui/theme.css'])
    expect(plan.tasks[0]!.dependsOn).toEqual([])
    expect(plan.tasks[1]!.dependsOn).toEqual([0])
    expect(plan.droppedFiles).toEqual(['nope/x.ts'])
  })

  it('rejects malformed plans', () => {
    expect(() => validatePlan({ tasks: [] }, repo)).toThrow()
    expect(() => validatePlan({ tasks: [{ title: 'x' }] }, repo)).toThrow()
  })

  it('extracts JSON from fenced or chatty replies', () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractJson('{"tasks":[]} trailing')).toEqual({ tasks: [] })
    expect(() => extractJson('no json')).toThrow()
  })

  it('inspects shared, parsable files first', () => {
    const plan = validatePlan(
      {
        tasks: [
          { title: 'aaa', files: ['src/api/users.ts', 'README.md'] },
          { title: 'bbb', files: ['src/api/users.ts', 'app/views.py'] },
        ],
      },
      repo,
    )
    expect(filesToInspect(plan, repo)).toEqual(['src/api/users.ts', 'app/views.py'])
  })

  it('filters generated and binary paths from trees', () => {
    const { paths } = filterTreePaths(['src/a.ts', 'node_modules/x/index.js', 'logo.png', 'package-lock.json', 'dist/a.js'])
    expect(paths).toEqual(['src/a.ts'])
  })
})

describe('input parsing', () => {
  it('parses repo references', () => {
    expect(parseRepoRef('vercel/next.js')).toEqual({ owner: 'vercel', repo: 'next.js' })
    expect(parseRepoRef('https://github.com/a/b.git')).toEqual({ owner: 'a', repo: 'b' })
    expect(parseRepoRef('git@github.com:a/b.git')).toEqual({ owner: 'a', repo: 'b' })
    expect(parseRepoRef('not a repo')).toBeNull()
  })

  it('parses PR URLs', () => {
    expect(parsePrUrl('https://github.com/a/b/pull/12/files')).toEqual({ owner: 'a', repo: 'b', number: 12 })
    expect(parsePrUrl('https://evil.example/a/b/pull/1')).toBeNull()
  })

  it('cleans agent file lists', () => {
    expect(cleanFileList(['./src/a.ts', 'src/a.ts', 5, '', '../x/../src/b.ts'])).toEqual(['src/a.ts', 'src/b.ts'])
    expect(cleanFileList('nope')).toEqual([])
  })
})
