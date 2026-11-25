/**
 * Needs-you inbox (decision #21): everything waiting on a person, across all
 * their teams. Team permissions already limit every query to the viewer's teams.
 */

import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useUser } from 'deepspace'
import { expected } from '@/lib/expected'
import { useLiveQuery } from '@/lib/optimistic'
import { AlertTriangle, Check, GitPullRequest, Inbox as InboxIcon, MessageCircleQuestion, PauseCircle, Undo2 } from 'lucide-react'
import { Button, Textarea } from '@/components/ui'
import { AgentChip, Loading, Page, Panel } from '@/components/conductor/Page'
import { useAction } from '@/lib/actions'
import { safeGithubUrl, timeAgo, type Agent, type OverlapRow, type Project, type Question, type Task } from '@/lib/conductor'

type Rec<T> = { recordId: string; data: T; createdAt: string; updatedAt: string }

export default function InboxPage() {
  const { user } = useUser()
  const me = user?.id ?? ''
  const { act } = useAction()
  // Live data with any just-clicked changes applied, so handled items leave at once.
  const reviewQuery = useLiveQuery<Task>('tasks', { where: { status: 'review' } })
  const status = reviewQuery.status
  const reviews = reviewQuery.records.filter((t) => t.data.status === 'review')
  const questions = useLiveQuery<Question>('questions', { where: { status: 'open' } }).records.filter((q) => q.data.status === 'open')
  const { records: myAgents } = useLiveQuery<Agent>('agents', { where: { ownerUserId: me || '__none__' } })
  const overlaps = useLiveQuery<OverlapRow>('overlaps', { where: { status: 'open' } }).records.filter((o) => o.data.status === 'open')
  const { records: tasks } = useLiveQuery<Task>('tasks', { limit: 1000 })
  const { records: projects } = useQuery<Project>('projects')

  const taskById = new Map(tasks.map((t) => [t.recordId, t]))
  const projectById = new Map(projects.map((p) => [p.recordId, p]))
  const boardLink = (t: { teamId: string; projectId: string }, taskId?: string) => `/t/${t.teamId}/p/${t.projectId}${taskId ? `?task=${taskId}` : ''}`
  const repoName = (projectId: string) => {
    const p = projectById.get(projectId)
    return p ? `${p.data.repoOwner}/${p.data.repoName}` : ''
  }

  const myAgentIds = new Set(myAgents.map((a) => a.recordId))
  const stuck = myAgents
    .map((a) => ({ agent: a, task: a.data.currentTaskId ? taskById.get(a.data.currentTaskId) : undefined }))
    .filter(({ agent, task }) => task && (agent.data.status === 'paused' || agent.data.status === 'offline' || task.data.status === 'blocked'))
  const myOverlaps = overlaps.filter((o) => [o.data.taskA, o.data.taskB].some((id) => myAgentIds.has(taskById.get(id)?.data.agentId ?? '')))
  const total = reviews.length + questions.length + stuck.length + myOverlaps.length

  if (status === 'loading') return <Page><Loading /></Page>

  return (
    <Page>
      <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
      <p className="mt-1 text-sm text-muted-foreground">Everything waiting on a person, across your teams.</p>

      {total === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-border p-10 text-center" data-testid="inbox-empty">
          <InboxIcon className="mx-auto h-8 w-8 text-muted-foreground" aria-hidden />
          <p className="mt-3 font-medium">Nothing needs you right now</p>
          <p className="mt-1 text-sm text-muted-foreground">Reviews, agent questions and stuck agents show up here.</p>
        </div>
      ) : (
        <div className="mt-6 space-y-5">
          {reviews.length > 0 && (
            <Panel title={`Waiting for review (${reviews.length})`} testId="inbox-reviews">
              <ul className="space-y-3">
                {reviews.map((t) => <ReviewItem key={t.recordId} task={t} repo={repoName(t.data.projectId)} href={boardLink(t.data, t.recordId)} act={act} />)}
              </ul>
            </Panel>
          )}

          {questions.length > 0 && (
            <Panel title={`Questions from agents (${questions.length})`} testId="inbox-questions">
              <ul className="space-y-3">
                {questions.map((q) => <QuestionItem key={q.recordId} question={q} repo={repoName(q.data.projectId)} href={boardLink(q.data, q.data.taskId || undefined)} act={act} me={user?.name || 'You'} />)}
              </ul>
            </Panel>
          )}

          {stuck.length > 0 && (
            <Panel title={`Your agents need attention (${stuck.length})`} testId="inbox-stuck">
              <ul className="space-y-2">
                {stuck.map(({ agent, task }) => (
                  <li key={agent.recordId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <PauseCircle className="h-4 w-4 shrink-0 text-st-paused" aria-hidden />
                      <AgentChip name={agent.data.name} />
                      <span className="text-muted-foreground">
                        {agent.data.status === 'paused' ? 'is paused' : agent.data.status === 'offline' ? `went offline ${timeAgo(agent.data.lastSeenAt)}` : 'is blocked'} holding
                      </span>
                      <Link to={boardLink(task!.data, task!.recordId)} className="truncate hover:text-primary">{task!.data.title}</Link>
                    </span>
                    {agent.data.status === 'paused' && (
                      <Button size="sm" variant="secondary" onClick={() => act('sendDirective', { agentId: agent.recordId, kind: 'resume' }, expected.resume(agent, task))}>Resume</Button>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {myOverlaps.length > 0 && (
            <Panel title={`Overlaps involving your agents (${myOverlaps.length})`} testId="inbox-overlaps">
              <ul className="space-y-2">
                {myOverlaps.map((o) => (
                  <li key={o.recordId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-st-paused" aria-hidden />
                      {taskById.get(o.data.taskA)?.data.title} <span className="text-muted-foreground">and</span> {taskById.get(o.data.taskB)?.data.title}
                      <span className="text-xs text-muted-foreground">({o.data.files.slice(0, 2).join(', ')})</span>
                    </span>
                    <span className="flex gap-1.5">
                      <Link to={boardLink(o.data)} className="text-xs text-primary hover:underline">Board</Link>
                      <Button size="sm" variant="ghost" onClick={() => act('setOverlapStatus', { overlapId: o.recordId, status: 'acknowledged' }, expected.overlap(o.recordId, 'acknowledged'))}>Acknowledge</Button>
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      )}
    </Page>
  )
}

type Act = ReturnType<typeof useAction>['act']

function ReviewItem({ task, repo, href, act }: { task: Rec<Task>; repo: string; href: string; act: Act }) {
  const [note, setNote] = useState('')
  const [asking, setAsking] = useState(false)
  const pr = safeGithubUrl(task.data.prUrl)
  function sendBack(e: FormEvent) {
    e.preventDefault()
    setAsking(false)
    void act('requestChanges', { taskId: task.recordId, note }, expected.requestChanges(task.recordId, note))
  }
  return (
    <li className="rounded-lg border border-st-review/40 p-3" data-testid="inbox-review">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link to={href} className="font-medium hover:text-primary">{task.data.title}</Link>
          <p className="text-xs text-muted-foreground">{repo} · submitted {timeAgo(task.updatedAt)}</p>
          {task.data.lastSummary && <p className="mt-1 line-clamp-2 text-xs">{task.data.lastSummary}</p>}
        </div>
        {pr && (
          <a href={pr} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
            <GitPullRequest className="h-3.5 w-3.5" aria-hidden /> PR ({task.data.prState || 'open'})
          </a>
        )}
      </div>
      {asking ? (
        <form onSubmit={sendBack} className="mt-2 space-y-2">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} placeholder="What should change?" aria-label="What should change?" autoFocus />
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={!note.trim()}>Send back</Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="mt-2 flex gap-2">
          <Button size="sm" onClick={() => act('approveTask', { taskId: task.recordId }, expected.approve(task.recordId))}><Check /> Approve</Button>
          <Button size="sm" variant="secondary" onClick={() => setAsking(true)}><Undo2 /> Request changes</Button>
        </div>
      )}
    </li>
  )
}

function QuestionItem({ question, repo, href, act, me }: { question: Rec<Question>; repo: string; href: string; act: Act; me: string }) {
  const [answer, setAnswer] = useState('')
  return (
    <li className="rounded-lg border border-primary/40 bg-primary/5 p-3">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <MessageCircleQuestion className="h-3.5 w-3.5" aria-hidden /> {repo} · {timeAgo(question.createdAt)} · <Link to={href} className="hover:text-foreground">open board</Link>
      </p>
      <p className="mt-1 whitespace-pre-wrap text-sm">{question.data.text}</p>
      <form
        className="mt-2 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          const text = answer
          setAnswer('')
          if (!(await act('answerQuestion', { questionId: question.recordId, answer: text }, expected.answer(question.recordId, text, me)))) setAnswer(text)
        }}
      >
        <Textarea rows={1} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer" maxLength={1000} className="min-h-9" aria-label="Your answer" />
        <Button type="submit" size="sm" disabled={!answer.trim()}>Answer</Button>
      </form>
    </li>
  )
}
