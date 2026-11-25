/**
 * GitHub on the board (decision #19): connect your GitHub account, mirror
 * tasks as issues, sync, and turn open issues into goals. Everything acts as,
 * and is billed to, the member who clicks.
 */

import { useCallback, useEffect, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { useQuery } from 'deepspace'
import { CircleDot, Copy, ExternalLink, GitPullRequest, Github, RefreshCw } from 'lucide-react'
import { Button, Input, Switch, useToast } from '@/components/ui'
import { Mono } from '@/components/conductor/Page'
import { cn } from '@/lib/utils'
import { safeGithubUrl, timeAgo, type GithubItem, type Project, type Task } from '@/lib/conductor'
import { expected } from '@/lib/expected'
import type { Patch } from '@/lib/optimistic'
import type { WebhookSetup } from '@/server/core/github-sync'

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

export function GithubPanel({
  project,
  tasks,
  run,
  act,
  pending,
  onOpenTask,
  onPlanIssue,
}: {
  project: Rec<Project>
  tasks: Array<Rec<Task>>
  run: Run
  act: Act
  pending: string | null
  onOpenTask: (id: string) => void
  /** Open the New goal dialog pre-filled with this issue, for the member to review before planning. */
  onPlanIssue: (issue: GithubItem) => void
}) {
  const projectId = project.recordId
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const { success, info } = useToast()
  const [connected, setConnected] = useState<boolean | null>(null)
  const [mirroringBusy, setMirroringBusy] = useState<'on' | 'off' | null>(null)
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
          <LiveUpdates project={project} run={run} pending={pending} />
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
                      onClick={() => onPlanIssue(i.data)}
                      title="Review this issue's text, then plan it into tasks (about 13 of your credits)"
                    >
                      Plan as goal
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

/**
 * Live updates (decision #24): a GitHub webhook tells Squadboard about issue and PR changes as they
 * happen. Squadboard adds it as the member when they're a repo admin; otherwise this shows the steps
 * (and the signing secret) for an admin to add it by hand.
 */
function LiveUpdates({ project, run, pending }: { project: Rec<Project>; run: Run; pending: string | null }) {
  const { success } = useToast()
  const [manual, setManual] = useState<Extract<WebhookSetup, { mode: 'manual' }> | null>(null)
  const { ghWebhook, ghWebhookAt } = project.data
  return (
    <div className="rounded-md border border-border p-2 text-[11px]" data-testid="live-updates">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground" data-testid="live-updates-status">
          {ghWebhookAt
            ? `Live updates on · last GitHub event ${timeAgo(ghWebhookAt)}`
            : ghWebhook === 'auto'
              ? 'Live updates on · waiting for the first GitHub event'
              : 'Closed issues and merged PRs show up when someone opens the board. Live updates show them at once.'}
        </span>
        {!ghWebhookAt && ghWebhook !== 'auto' && (
          <Button
            size="sm"
            variant="secondary"
            className="h-7 shrink-0 px-2 text-[11px]"
            disabled={pending === 'setupGithubWebhook'}
            data-testid="setup-webhook"
            onClick={async () => {
              const r = await run<WebhookSetup>('setupGithubWebhook', { projectId: project.recordId })
              if (r?.mode === 'auto') {
                setManual(null)
                success('Live updates on', 'GitHub now tells Squadboard about issue and PR changes as they happen.')
              }
              if (r?.mode === 'manual') setManual(r)
            }}
          >
            {ghWebhook === 'manual' ? 'Show setup' : 'Turn on'}
          </Button>
        )}
      </div>
      {manual && (
        <div className="mt-2 space-y-1.5" data-testid="webhook-manual">
          <p>{manual.reason} Ask one to open the repo's Settings → Webhooks → Add webhook and enter:</p>
          <CopyField label="Payload URL" value={manual.url} />
          <p>Content type: <Mono>application/json</Mono></p>
          <CopyField label="Secret" value={manual.secret} />
          <p>Events: “Let me select individual events”, then tick Issues and Pull requests. Keep the secret private.</p>
        </div>
      )}
    </div>
  )
}

function CopyField({ label, value }: { label: string; value: string }) {
  const { success } = useToast()
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-20 shrink-0">{label}</span>
      <Input readOnly value={value} aria-label={label} className="h-7 font-mono text-[11px]" onFocus={(e) => e.currentTarget.select()} />
      <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label={`Copy ${label}`} onClick={() => navigator.clipboard.writeText(value).then(() => success(`${label} copied`))}>
        <Copy />
      </Button>
    </div>
  )
}
