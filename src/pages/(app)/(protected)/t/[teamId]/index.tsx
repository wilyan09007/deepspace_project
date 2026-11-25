import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useUser } from 'deepspace'
import { ArrowRight, Copy, FlaskConical, GitBranch, Mail } from 'lucide-react'
import { Button, Input, Label, Switch, useToast } from '@/components/ui'
import { Crumbs, Loading, Mono, Page, Panel } from '@/components/conductor/Page'
import { useAction } from '@/lib/actions'
import { timeAgo, type Digest, type Member, type Project, type Team } from '@/lib/conductor'

export default function TeamPage() {
  const { teamId = '' } = useParams()
  const { user } = useUser()
  const navigate = useNavigate()
  const { success } = useToast()
  const { run, pending } = useAction()
  const { records: teams, status } = useQuery<Team>('teams', { where: { teamId } })
  const { records: members } = useQuery<Member>('team_members', { where: { teamId } })
  const { records: projects } = useQuery<Project>('projects', { where: { teamId } })
  const { records: digests } = useQuery<Digest>('digests', { where: { teamId }, orderBy: 'date', orderDir: 'desc', limit: 7 })
  const [repo, setRepo] = useState('')
  const [invite, setInvite] = useState<{ code: string; expiresAt: number } | null>(null)
  const [sampleReady, setSampleReady] = useState(false)

  useEffect(() => {
    run<{ available: boolean }>('sampleStatus', {}, { quiet: true }).then((r) => setSampleReady(!!r?.available))
  }, [run])

  const team = teams[0]
  const active = members.filter((m) => m.data.status !== 'removed')
  const mine = active.find((m) => m.data.userId === user?.id)

  if (status === 'loading') return <Page><Loading /></Page>
  if (!team) {
    return (
      <Page>
        <p className="mt-16 text-center text-sm text-muted-foreground" data-testid="team-not-found">
          This team doesn't exist or you're not a member. <Link className="text-primary hover:underline" to="/teams">Your teams</Link>
        </p>
      </Page>
    )
  }

  async function addProject(e: FormEvent) {
    e.preventDefault()
    const res = await run<{ projectId: string }>('createProject', { teamId, repo })
    if (res) navigate(`/t/${teamId}/p/${res.projectId}`)
  }
  async function makeInvite() {
    const res = await run<{ code: string; expiresAt: number }>('createInvite', { teamId })
    if (res) setInvite(res)
  }
  async function loadSample() {
    const res = await run<{ projectId: string }>('loadSample', { teamId })
    if (res) navigate(`/t/${teamId}/p/${res.projectId}`)
  }
  const inviteUrl = invite ? `${window.location.origin}/join/${invite.code}` : ''

  return (
    <Page>
      <Crumbs items={[{ label: 'Teams', to: '/teams' }, { label: team.data.name }]} />
      <h1 className="text-2xl font-semibold tracking-tight" data-testid="team-name">{team.data.name}</h1>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <Panel title="Projects" testId="projects-panel">
            {projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">Add a public GitHub repository your agents work on{sampleReady ? ', or try the sample' : ''}.</p>
            ) : (
              <ul className="divide-y divide-border">
                {projects.map((p) => (
                  <li key={p.recordId}>
                    <Link to={`/t/${teamId}/p/${p.recordId}`} className="group flex items-center gap-3 py-3">
                      {p.data.kind === 'sample' ? <FlaskConical className="h-4 w-4 text-primary" aria-hidden /> : <GitBranch className="h-4 w-4 text-muted-foreground" aria-hidden />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {p.data.repoOwner}/{p.data.repoName}
                          {p.data.kind === 'sample' && <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">sample</span>}
                        </span>
                        {p.data.description && <span className="block truncate text-xs text-muted-foreground">{p.data.description}</span>}
                      </span>
                      <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <form onSubmit={addProject} className="mt-4 flex flex-col gap-2 sm:flex-row">
              <Label htmlFor="repo" className="sr-only">Repository</Label>
              <Input id="repo" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo or https://github.com/owner/repo" className="flex-1" />
              <Button type="submit" disabled={!repo.trim() || pending === 'createProject'}>
                {pending === 'createProject' ? 'Checking repo…' : 'Add project'}
              </Button>
            </form>
            <p className="mt-2 text-xs text-muted-foreground">Public repositories only. Checking the repo uses a tiny amount of your DeepSpace credits.</p>
            {sampleReady && (
              <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-dashed border-border p-3">
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Try a sample.</span> Loads a plan captured from a real planner run, then you can run the demo agents on it. Free.
                </p>
                <Button size="sm" variant="secondary" onClick={loadSample} disabled={pending === 'loadSample'}>
                  {pending === 'loadSample' ? 'Loading…' : 'Load sample'}
                </Button>
              </div>
            )}
            {import.meta.env.DEV && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-3"
                data-testid="dev-fixture"
                onClick={async () => {
                  const res = await run<{ projectId: string }>('devSeedFixture', { teamId })
                  if (res) navigate(`/t/${teamId}/p/${res.projectId}`)
                }}
              >
                Load test fixture (dev only)
              </Button>
            )}
          </Panel>

          <Panel title="Daily digests">
            {digests.length === 0 ? (
              <p className="text-sm text-muted-foreground">A summary of each day's work appears here at 22:00 UTC on days with activity.</p>
            ) : (
              <div className="space-y-4">
                {digests.map((d) => (
                  <article key={d.recordId}>
                    <h3 className="text-xs font-semibold text-muted-foreground">{d.data.date}</h3>
                    <pre className="mt-1 whitespace-pre-wrap font-sans text-sm leading-relaxed">{d.data.body.split('\n').slice(1).join('\n').trim()}</pre>
                  </article>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel title={`Members (${active.length})`} testId="members-panel">
            <ul className="space-y-2">
              {active.map((m) => (
                <li key={m.recordId} className="flex items-center justify-between text-sm">
                  <span className="truncate">{m.data.userName || 'Member'}{m.data.userId === user?.id && <span className="text-muted-foreground"> (you)</span>}</span>
                  <span className="text-xs text-muted-foreground">{m.data.role}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 border-t border-border pt-4">
              {invite ? (
                <div className="space-y-2" data-testid="invite-link">
                  <p className="text-xs text-muted-foreground">Share this link. It works once and expires {new Date(invite.expiresAt).toLocaleDateString()}.</p>
                  <div className="flex gap-2">
                    <Input readOnly value={inviteUrl} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                    <Button size="icon" variant="secondary" aria-label="Copy invite link" onClick={() => navigator.clipboard.writeText(inviteUrl).then(() => success('Invite link copied'))}>
                      <Copy />
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">Or share the code <Mono>{invite.code}</Mono></p>
                </div>
              ) : (
                <Button variant="secondary" className="w-full" onClick={makeInvite} disabled={pending === 'createInvite'}>
                  Invite a teammate
                </Button>
              )}
            </div>
          </Panel>

          <Panel title={<span className="flex items-center gap-2"><Mail className="h-4 w-4" aria-hidden />Digest email</span>}>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Email me the daily digest</span>
              <Switch
                checked={mine?.data.digestOptIn === 1}
                onCheckedChange={(on: boolean) => run('setDigestOptIn', { teamId, on })}
                aria-label="Email me the daily digest"
              />
            </label>
            <p className="mt-2 text-xs text-muted-foreground">
              Emails are limited to a few per day across the whole app, so on busy days some may not go out. The digest is always on this page.
            </p>
          </Panel>
          {digests[0] && <p className="text-xs text-muted-foreground">Last digest {timeAgo(digests[0].createdAt)}.</p>}
        </div>
      </div>
    </Page>
  )
}
