import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery, useUser } from 'deepspace'
import { Bot, ExternalLink, FlaskConical, Loader2, Plug, Plus, RotateCcw, Sparkles, Square, X } from 'lucide-react'
import { Button, Input, Label, Modal, Textarea, buttonVariants } from '@/components/ui'
import { ChatPanel } from '@/components/ChatPanel'
import { ActivityFeed, AgentsPanel, OverlapsPanel, QuestionsPanel, TaskCard, TaskDetail } from '@/components/conductor/Board'
import { Crumbs, Loading, Page, Panel } from '@/components/conductor/Page'
import { useAction } from '@/lib/actions'
import {
  COLUMNS,
  GOAL_STATUS,
  repoUrl,
  type Agent,
  type EventRow,
  type Goal,
  type OverlapRow,
  type Project,
  type Question,
  type Task,
  type Team,
} from '@/lib/conductor'
import { cn } from '@/lib/utils'

export default function BoardPage() {
  const { teamId = '', projectId = '' } = useParams()
  const { user } = useUser()
  const { run, pending } = useAction()
  const { records: teams } = useQuery<Team>('teams', { where: { teamId } })
  const { records: projects, status } = useQuery<Project>('projects', { where: { teamId } })
  const { records: goals } = useQuery<Goal>('goals', { where: { projectId } })
  const { records: tasks } = useQuery<Task>('tasks', { where: { projectId } })
  const { records: agents } = useQuery<Agent>('agents', { where: { projectId } })
  const { records: overlaps } = useQuery<OverlapRow>('overlaps', { where: { projectId } })
  const { records: questions } = useQuery<Question>('questions', { where: { projectId } })
  const { records: events } = useQuery<EventRow>('events', { where: { projectId }, orderBy: 'at', orderDir: 'desc', limit: 40 })

  const project = projects.find((p) => p.recordId === projectId)
  const [pickedGoal, setPickedGoal] = useState<string | null>(null)
  const [newGoalOpen, setNewGoalOpen] = useState(false)
  const [openTask, setOpenTask] = useState<string | null>(null)
  const [askOpen, setAskOpen] = useState(false)
  const [, setTick] = useState(0)

  // Re-render every 30 s so "x min ago" stays honest.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  // Refresh PR states on open (user-billed, throttled server-side to once per 10 min per project).
  useEffect(() => {
    if (project?.data.kind === 'repo' && tasks.some((t) => t.data.prUrl)) {
      void run('refreshPrs', { projectId }, { quiet: true })
    }
  }, [project?.recordId, tasks.length > 0])

  const sortedGoals = useMemo(() => [...goals].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [goals])
  const goal = sortedGoals.find((g) => g.recordId === pickedGoal) ?? sortedGoals[0]
  const goalTasks = useMemo(
    () => tasks.filter((t) => t.data.goalId === goal?.recordId).sort((a, b) => a.data.order - b.data.order),
    [tasks, goal?.recordId],
  )
  const liveOverlaps = overlaps.filter((o) => o.data.status !== 'resolved')
  const overlapCount = (taskId: string) => liveOverlaps.filter((o) => o.data.taskA === taskId || o.data.taskB === taskId).length
  const titleOf = (id: string) => tasks.find((t) => t.recordId === id)?.data.title ?? 'another task'
  const demoRunning = goals.some((g) => g.data.demoState === 'running' || g.data.demoState === 'stopping')
  const openQuestions = questions.filter((q) => q.data.status === 'open').length
  const detail = openTask ? tasks.find((t) => t.recordId === openTask) ?? null : null

  if (status === 'loading') return <Page wide><Loading /></Page>
  if (!project) {
    return (
      <Page>
        <p className="mt-16 text-center text-sm text-muted-foreground" data-testid="project-not-found">
          This project doesn't exist or you're not in its team. <Link className="text-primary hover:underline" to="/teams">Your teams</Link>
        </p>
      </Page>
    )
  }
  const isSample = project.data.kind === 'sample'

  return (
    <Page wide>
      <Crumbs items={[{ label: 'Teams', to: '/teams' }, { label: teams[0]?.data.name ?? 'Team', to: `/t/${teamId}` }, { label: `${project.data.repoOwner}/${project.data.repoName}` }]} />
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight sm:text-2xl" data-testid="board-title">
            {isSample && <FlaskConical className="h-5 w-5 text-primary" aria-hidden />}
            <span className="truncate">{project.data.repoOwner}/{project.data.repoName}</span>
            <a href={repoUrl(project.data)} target="_blank" rel="noreferrer noopener" aria-label="Open on GitHub" className="text-muted-foreground hover:text-foreground">
              <ExternalLink className="h-4 w-4" />
            </a>
          </h1>
          {isSample && <p className="mt-0.5 text-xs text-muted-foreground">Sample project{project.data.description ? `: ${project.data.description}` : ''} Use the demo agents to see it work.</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {demoRunning ? (
            <Button variant="secondary" onClick={() => run('stopDemo', { projectId })} disabled={pending === 'stopDemo'} data-testid="stop-demo">
              <Square /> Stop demo
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => run('startDemo', { projectId })} disabled={pending === 'startDemo' || !goalTasks.length} data-testid="start-demo" title={goalTasks.length ? 'Three scripted agents work this goal so you can watch and steer. Free.' : 'Plan a goal first'}>
              <Bot /> {pending === 'startDemo' ? 'Starting…' : 'Run demo agents'}
            </Button>
          )}
          <Link to={`/t/${teamId}/p/${projectId}/connect`} className={buttonVariants({ variant: 'secondary' })}>
            <Plug /> Connect an agent
          </Link>
          <Button variant="secondary" onClick={() => setAskOpen(true)} data-testid="open-assistant">
            <Sparkles /> Ask
          </Button>
        </div>
      </header>

      {/* Goals */}
      <div className="mt-5 flex flex-wrap items-center gap-2" role="tablist" aria-label="Goals">
        {sortedGoals.map((g) => (
          <button
            key={g.recordId}
            role="tab"
            aria-selected={g.recordId === goal?.recordId}
            onClick={() => setPickedGoal(g.recordId)}
            className={cn(
              'max-w-full truncate rounded-full border px-3 py-1 text-xs transition-colors sm:max-w-[28rem]',
              g.recordId === goal?.recordId ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {g.data.title}
            <span className="ml-1.5 opacity-70">· {GOAL_STATUS[g.data.status]}</span>
          </button>
        ))}
        {!isSample && (
          <Button size="sm" onClick={() => setNewGoalOpen(true)} data-testid="new-goal">
            <Plus /> New goal
          </Button>
        )}
      </div>

      {goal ? (
        <GoalHeader goal={goal} onRetry={() => run('retryPlan', { goalId: goal.recordId })} retrying={pending === 'retryPlan'} />
      ) : (
        <div className="mt-6 rounded-xl border border-dashed border-border p-10 text-center">
          <p className="font-medium">No goals yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Describe what you want built. Conductor reads the repo and splits it into tasks with the files each will touch, so agents can work in parallel without colliding.
          </p>
          <Button className="mt-4" onClick={() => setNewGoalOpen(true)}><Plus /> New goal</Button>
        </div>
      )}

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* Task columns */}
        <div className="grid content-start gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="task-columns">
          {COLUMNS.map((col) => {
            const items = goalTasks.filter((t) => (col.statuses as readonly string[]).includes(t.data.status))
            return (
              <section key={col.id} className="flex min-h-40 flex-col rounded-xl border border-border bg-card/60" aria-label={col.title}>
                <h2 className="flex items-center justify-between px-3 pb-2 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {col.title} <span className="rounded bg-muted px-1.5 font-mono">{items.length}</span>
                </h2>
                <div className="flex flex-1 flex-col gap-2 px-2 pb-2">
                  {items.map((t) => (
                    <TaskCard
                      key={t.recordId}
                      task={t}
                      agent={t.data.agentId ? agents.find((a) => a.recordId === t.data.agentId) : undefined}
                      overlapCount={overlapCount(t.recordId)}
                      waitingOn={(t.data.dependsOn ?? []).filter((d) => tasks.find((x) => x.recordId === d)?.data.status !== 'done').map(titleOf)}
                      onOpen={() => setOpenTask(t.recordId)}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>

        {/* Side rail */}
        <div className="space-y-4">
          {(openQuestions > 0 || questions.length > 0) && (
            <Panel title={<>Questions {openQuestions > 0 && <span className="ml-1 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">{openQuestions}</span>}</>}>
              <QuestionsPanel questions={questions} agents={agents} run={run} />
            </Panel>
          )}
          <Panel title={<>Overlaps {liveOverlaps.length > 0 && <span className="ml-1 rounded-full bg-st-paused px-1.5 text-[10px] text-black">{liveOverlaps.length}</span>}</>} testId="overlaps-panel">
            <OverlapsPanel overlaps={overlaps} tasks={tasks} agents={agents} run={run} />
          </Panel>
          <Panel title="Agents" testId="agents-panel">
            <AgentsPanel agents={agents} tasks={tasks} run={run} pending={pending} />
          </Panel>
          <Panel title="Activity" testId="activity-panel">
            <ActivityFeed events={events} />
          </Panel>
        </div>
      </div>

      <TaskDetail
        task={detail}
        agent={detail?.data.agentId ? agents.find((a) => a.recordId === detail.data.agentId) : undefined}
        deps={(detail?.data.dependsOn ?? []).map((d) => tasks.find((t) => t.recordId === d)!).filter(Boolean)}
        onClose={() => setOpenTask(null)}
      />
      <NewGoalModal
        open={newGoalOpen}
        onClose={() => setNewGoalOpen(false)}
        onSubmit={async (title, body) => {
          setNewGoalOpen(false)
          setPickedGoal(null) // show the newest goal, i.e. the one being planned
          await run('planGoal', { projectId, title, body })
        }}
      />
      {askOpen && user && (
        <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-border bg-background shadow-2xl" aria-label="Assistant">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-semibold">Ask about your agents</p>
            <Button size="icon" variant="ghost" onClick={() => setAskOpen(false)} aria-label="Close assistant"><X /></Button>
          </div>
          <ChatPanel
            chatId={null}
            userId={user.id}
            compact
            className="min-h-0 flex-1"
            emptyStatePrompts={[
              `What is each agent doing on ${project.data.repoOwner}/${project.data.repoName}?`,
              'Are any agents working on the same files?',
              'Which questions are waiting for an answer?',
            ]}
          />
        </aside>
      )}
    </Page>
  )
}

function GoalHeader({ goal, onRetry, retrying }: { goal: { recordId: string; data: Goal; updatedAt: string }; onRetry: () => void; retrying: boolean }) {
  const g = goal.data
  const stalled = g.status === 'planning' && Date.now() - Date.parse(goal.updatedAt) > 3 * 60 * 1000
  return (
    <div className="mt-4 rounded-xl border border-border bg-card p-4" data-testid="goal-header">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-semibold">{g.title}</h2>
          {g.body && <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">{g.body}</p>}
        </div>
        <span className="text-xs text-muted-foreground">
          {GOAL_STATUS[g.status]}
          {g.createdByName && ` · set by ${g.createdByName}`}
        </span>
      </div>
      {g.status === 'planning' && !stalled && (
        <p className="mt-3 flex items-center gap-2 text-sm text-primary" data-testid="plan-stage">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {g.planStage ? `${g.planStage[0]!.toUpperCase()}${g.planStage.slice(1)}…` : 'Planning…'}
        </p>
      )}
      {(g.status === 'failed' || stalled) && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <span className="flex-1">{stalled ? 'Planning stopped before it finished.' : g.planError || 'Planning failed.'}</span>
          <Button size="sm" variant="secondary" onClick={onRetry} disabled={retrying}>
            <RotateCcw /> {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      )}
      {g.planSummary && <p className="mt-3 text-sm">{g.planSummary}</p>}
      {g.planModel && g.status !== 'planning' && (
        <p className="mt-2 text-[11px] text-muted-foreground">{g.source === 'sample' ? `Captured sample plan from ${g.planModel}.` : `Planned by ${g.planModel}.`}</p>
      )}
    </div>
  )
}

function NewGoalModal({ open, onClose, onSubmit }: { open: boolean; onClose: () => void; onSubmit: (title: string, body: string) => void }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  function submit(e: FormEvent) {
    e.preventDefault()
    onSubmit(title, body)
    setTitle('')
    setBody('')
  }
  return (
    <Modal open={open} onClose={onClose}>
      <form onSubmit={submit}>
        <Modal.Header>
          <Modal.Title>New goal</Modal.Title>
          <Modal.Description>Conductor reads the repository and plans tasks for your agents. Planning uses your own DeepSpace credits (one Claude call plus a few GitHub reads).</Modal.Description>
        </Modal.Header>
        <Modal.Body className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="goal-title">Goal</Label>
            <Input id="goal-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} placeholder="Add dark mode to the settings page" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="goal-body">Details (optional)</Label>
            <Textarea id="goal-body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} rows={4} placeholder="Constraints, acceptance criteria, files to avoid…" />
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={title.trim().length < 3}>Plan it</Button>
        </Modal.Footer>
      </form>
    </Modal>
  )
}
