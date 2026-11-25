/**
 * GitHub on the board (decision #19): connect your GitHub account, mirror
 * tasks as issues, sync, and turn open issues into goals. Everything acts as,
 * and is billed to, the member who clicks.
 */

import { useCallback, useEffect, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useQuery } from 'deepspace'
import { CircleDot, ExternalLink, GitPullRequest, Github, RefreshCw } from 'lucide-react'
import { Button, Switch, useToast } from '@/components/ui'
import { cn } from '@/lib/utils'
import { safeGithubUrl, timeAgo, type GithubItem, type Project, type Task } from '@/lib/conductor'
import { expected } from '@/lib/expected'
import type { Patch } from '@/lib/optimistic'

type Rec<T> = { recordId: string; data: T }
type Run = <T>(name: string, params?: Record<string, unknown>, opts?: { quiet?: boolean }) => Promise<T | null>
type Act = <T>(name: string, params: Record<string, unknown>, expected: Patch[]) => Promise<T | null>

interface SyncResult {
  skipped?: string
  created: number
  updated: number
  linkedPrs: number
  doneFromGithub: number
}

export function GithubPanel({ project, tasks, run, act, pending, onOpenTask }: { project: Rec<Project>; tasks: Array<Rec<Task>>; run: Run; act: Act; pending: string | null; onOpenTask: (id: string) => void }) {
  const projectId = project.recordId
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const { success, info } = useToast()
  const [connected, setConnected] = useState<boolean | null>(null)
  const [mirroringBusy, setMirroringBusy] = useState<'on' | 'off' | null>(null)
  const [planning, setPlanning] = useState<number | null>(null)
  const { records: items } = useQuery<GithubItem>('github_items', { where: { projectId } })
  const titleOf = (id: string) => tasks.find((t) => t.recordId === id)?.data.title

  const sync = useCallback(
    async (force: boolean) => {
      const r = await run<SyncResult>('syncGithub', { projectId, force }, { quiet: !force })
      if (r && force) {
        const parts = [
          r.created && `${r.created} issue(s) created`,
          r.updated && `${r.updated} updated`,
          r.linkedPrs && `${r.linkedPrs} PR(s) linked`,
          r.doneFromGithub && `${r.doneFromGithub} task(s) closed on GitHub`,
        ].filter(Boolean)
        success('Synced with GitHub', parts.join(', ') || 'Everything was already up to date.')
      }
    },
    [projectId, run, success],
  )

  useEffect(() => {
    let live = true
    void run<{ connected: boolean }>('githubStatus', {}, { quiet: true }).then((r) => {
      if (!live) return
      setConnected(!!r?.connected)
      // Opening the board syncs quietly (throttled to once per 2 minutes per project, server-side).
      if (r?.connected) void sync(false)
    })
    if (params.get('github') === 'connected') {
      params.delete('github')
      setParams(params, { replace: true })
    }
    return () => {
      live = false
    }
  }, [projectId])

  async function connect() {
    const r = await run<{ url: string }>('connectGithub', { returnTo: `${location.pathname}?github=connected` })
    if (r?.url) window.location.href = r.url
  }

  const issues = items.filter((i) => i.data.kind === 'issue').sort((a, b) => b.data.number - a.data.number)
  const prs = items.filter((i) => i.data.kind === 'pr').sort((a, b) => b.data.number - a.data.number)
  const unlinkedIssues = issues.filter((i) => !i.data.linkedTaskId)

  return (
    <div className="space-y-3 text-sm" data-testid="github-panel">
      {connected === null ? (
        <p className="text-xs text-muted-foreground">Checking your GitHub connection…</p>
      ) : !connected ? (
        <div>
          <p className="text-xs text-muted-foreground">
            Connect your GitHub account to mirror tasks as issues, see this repo's issues and pull requests here, and use private repos. Squadboard acts on GitHub as you.
          </p>
          <Button size="sm" className="mt-2" onClick={connect} disabled={pending === 'connectGithub'} data-testid="connect-github">
            <Github /> Connect GitHub
          </Button>
        </div>
      ) : (
        <>
          <label className="flex items-center justify-between gap-3">
            <span>
              Mirror tasks as GitHub issues
              <span className="block text-[11px] text-muted-foreground" data-testid="mirror-status">
                {mirroringBusy === 'on'
                  ? 'Turning on… checking your access and creating issues on GitHub.'
                  : mirroringBusy === 'off'
                    ? 'Turning off…'
                    : "Labels show each task's status; done closes the issue."}
              </span>
            </span>
            <Switch
              checked={project.data.mirrorIssues === 1}
              onCheckedChange={async (on: boolean) => {
                // Flip at once; the GitHub work (access check, labels, issues) finishes in the background.
                setMirroringBusy(on ? 'on' : 'off')
                const r = await act<SyncResult | { mirrorIssues: false }>('setMirroring', { projectId, on }, expected.mirroring(projectId, on))
                setMirroringBusy(null)
                if (r && on && 'created' in r) success('Mirroring on', `${r.created} issue(s) created.`)
                if (r && !on) info('Mirroring off', 'Existing issues stay on GitHub.')
              }}
              disabled={mirroringBusy !== null}
              aria-label="Mirror tasks as GitHub issues"
              data-testid="mirror-switch"
            />
          </label>
          <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>
              {project.data.ghSyncedAt ? `Synced ${timeAgo(project.data.ghSyncedAt)}` : 'Not synced yet'}
              {project.data.mirrorIssues === 1 && project.data.mirrorBy ? ` · mirroring turned on by ${project.data.mirrorBy}` : ''}
            </span>
            <Button size="sm" variant="ghost" onClick={() => sync(true)} disabled={pending === 'syncGithub'} data-testid="sync-github">
              <RefreshCw className={cn(pending === 'syncGithub' && 'animate-spin')} /> Sync now
            </Button>
          </div>
          <button type="button" onClick={connect} className="text-[11px] text-muted-foreground hover:text-foreground hover:underline">
            Reconnect GitHub (change which repositories Squadboard can use)
          </button>
          {project.data.ghSyncError && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs">{project.data.ghSyncError}</p>}
        </>
      )}

      {(unlinkedIssues.length > 0 || prs.length > 0) && (
        <div className="space-y-3 border-t border-border pt-3">
          {unlinkedIssues.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">Open issues</h3>
              <ul className="mt-1.5 space-y-1.5" data-testid="github-issues">
                {unlinkedIssues.slice(0, 8).map((i) => (
                  <li key={i.recordId} className="flex items-start justify-between gap-2">
                    <a href={safeGithubUrl(i.data.url) ?? undefined} target="_blank" rel="noreferrer noopener" className="min-w-0 text-xs hover:text-primary">
                      <CircleDot className="mr-1 inline h-3 w-3 text-st-done" aria-hidden />
                      <span className="text-muted-foreground">#{i.data.number}</span> {i.data.title}
                    </a>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 shrink-0 px-2 text-[11px]"
                      onClick={async () => {
                        // The new goal appears on the board at once (it's created before planning starts).
                        setPlanning(i.data.number)
                        await run('planFromIssue', { projectId, issueNumber: i.data.number })
                        setPlanning(null)
                      }}
                      disabled={planning !== null}
                      title="Plan this issue into tasks (about 13 of your credits)"
                    >
                      {planning === i.data.number ? 'Planning…' : 'Plan as goal'}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {prs.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">Open pull requests</h3>
              <ul className="mt-1.5 space-y-1.5" data-testid="github-prs">
                {prs.slice(0, 8).map((p) => (
                  <li key={p.recordId} className="text-xs">
                    <a href={safeGithubUrl(p.data.url) ?? undefined} target="_blank" rel="noreferrer noopener" className="hover:text-primary">
                      <GitPullRequest className="mr-1 inline h-3 w-3 text-st-working" aria-hidden />
                      <span className="text-muted-foreground">#{p.data.number}</span> {p.data.title} <ExternalLink className="inline h-3 w-3 text-muted-foreground" aria-hidden />
                    </a>
                    <span className="block pl-4 text-[11px] text-muted-foreground">
                      {p.data.linkedTaskId ? (
                        <button className="hover:text-foreground hover:underline" onClick={() => onOpenTask(p.data.linkedTaskId)}>
                          → {titleOf(p.data.linkedTaskId) ?? 'a task'}
                        </button>
                      ) : (
                        `by ${p.data.author || 'someone'} · not linked to a task`
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
