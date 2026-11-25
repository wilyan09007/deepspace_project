import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useUser } from 'deepspace'
import { ArrowRight, Users } from 'lucide-react'
import { Button, Input, Label } from '@/components/ui'
import { Loading, Page, Panel } from '@/components/conductor/Page'
import { useAction } from '@/lib/actions'
import type { Member, Project, Team } from '@/lib/conductor'

export default function TeamsPage() {
  const { user } = useUser()
  const me = user?.id
  const { records: memberships, status } = useQuery<Member>('team_members', { where: me ? { userId: me } : { userId: '__none__' } })
  const { records: teams } = useQuery<Team>('teams')
  const { records: projects } = useQuery<Project>('projects')
  const { run, pending } = useAction()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')

  const myTeams = memberships
    .filter((m) => m.data.status !== 'removed')
    .map((m) => ({ member: m, team: teams.find((t) => t.recordId === m.data.teamId) }))
    .filter((x) => x.team)

  async function create(e: FormEvent) {
    e.preventDefault()
    const res = await run<{ teamId: string }>('createTeam', { name })
    if (res) navigate(`/t/${res.teamId}`)
  }
  async function join(e: FormEvent) {
    e.preventDefault()
    const res = await run<{ teamId: string }>('joinTeam', { code })
    if (res) navigate(`/t/${res.teamId}`)
  }

  return (
    <Page>
      <h1 className="text-2xl font-semibold tracking-tight">Your teams</h1>
      <p className="mt-1 text-sm text-muted-foreground">A team shares projects, and sees and steers every agent working on them.</p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div data-testid="team-list">
          {status === 'loading' ? (
            <Loading />
          ) : myTeams.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-8 text-center">
              <Users className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
              <p className="mt-3 font-medium">No teams yet</p>
              <p className="mt-1 text-sm text-muted-foreground">Create one for your group, or paste an invite code from a teammate.</p>
            </div>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {myTeams.map(({ member, team }) => {
                const count = projects.filter((p) => p.data.teamId === team!.recordId).length
                return (
                  <li key={team!.recordId}>
                    <Link
                      to={`/t/${team!.recordId}`}
                      className="group flex h-full flex-col rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50"
                    >
                      <span className="flex items-center justify-between">
                        <span className="font-medium">{team!.data.name}</span>
                        <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
                      </span>
                      <span className="mt-1 text-xs text-muted-foreground">
                        {count} project{count === 1 ? '' : 's'} · {member.data.role === 'owner' ? 'owner' : 'member'}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="space-y-4">
          <Panel title="New team">
            <form onSubmit={create} className="space-y-2">
              <Label htmlFor="team-name">Name</Label>
              <Input id="team-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Platform squad" />
              <Button type="submit" className="w-full" disabled={!name.trim() || pending === 'createTeam'}>
                {pending === 'createTeam' ? 'Creating…' : 'Create team'}
              </Button>
            </form>
          </Panel>
          <Panel title="Join with a code">
            <form onSubmit={join} className="space-y-2">
              <Label htmlFor="invite-code">Invite code</Label>
              <Input id="invite-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD2345" className="font-mono uppercase tracking-widest" />
              <Button type="submit" variant="secondary" className="w-full" disabled={code.trim().length < 8 || pending === 'joinTeam'}>
                {pending === 'joinTeam' ? 'Joining…' : 'Join team'}
              </Button>
            </form>
          </Panel>
        </div>
      </div>
    </Page>
  )
}
