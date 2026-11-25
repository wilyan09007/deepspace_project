import { describe, expect, it } from 'vitest'
import { parseFileContent, parsePr, parseRepo, parseTree } from './github'

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))

describe('GitHub response parsing', () => {
  it('reads the REST shape at the top level or wrapped', () => {
    const repo = { full_name: 'a/b', default_branch: 'trunk', description: null, private: false }
    expect(parseRepo(repo)).toEqual({ fullName: 'a/b', defaultBranch: 'trunk', description: '', isPrivate: false })
    expect(parseRepo({ data: repo }).defaultBranch).toBe('trunk')
    expect(parseRepo({ success: true, result: { data: repo } }).defaultBranch).toBe('trunk')
    expect(() => parseRepo({ nope: 1 })).toThrow(/default_branch/)
  })

  it('keeps only blobs from a tree', () => {
    const tree = { tree: [{ path: 'src', type: 'tree' }, { path: 'src/a.ts', type: 'blob' }], truncated: true }
    expect(parseTree({ data: tree })).toEqual({ paths: ['src/a.ts'], truncated: true })
  })

  it('decodes base64 file content including UTF-8 and line breaks', () => {
    const text = "import x from './y' // café\n"
    const encoded = b64(text).replace(/(.{10})/g, '$1\n')
    expect(parseFileContent({ type: 'file', encoding: 'base64', content: encoded })).toBe(text)
    expect(parseFileContent({ type: 'dir', content: '' })).toBeNull()
    expect(parseFileContent('plain text')).toBe('plain text')
  })

  it('maps PR state, treating merged-closed as merged', () => {
    expect(parsePr({ state: 'open', merged: false })).toBe('open')
    expect(parsePr({ state: 'closed', merged: true })).toBe('merged')
    expect(parsePr({ state: 'closed', merged_at: '2026-01-01T00:00:00Z' })).toBe('merged')
    expect(parsePr({ state: 'closed', merged_at: null })).toBe('closed')
  })
})
