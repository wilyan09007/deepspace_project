/**
 * Board panels. Everything here renders records that agents wrote, so it is
 * treated as plain text: no HTML, and only github.com links become links.
 */

import { useState, type FormEvent } from 'react'
import { useQuery } from 'deepspace'
import { AlertTriangle, Check, CheckCheck, CircleDot, ExternalLink, GitPullRequest, MessageSquareText, Pause, Play, Send, Undo2 } from 'lucide-react'
import { Button, ConfirmModal, Input, Modal, Textarea } from '@/components/ui'
import { cn } from '@/lib/utils'
import { expected } from '@/lib/expected'
import type { Patch } from '@/lib/optimistic'
import { AgentChip, Mono } from './Page'
import {
  AGENT_STATUS,
  TASK_STATUS,
  safeGithubUrl,
  timeAgo,
  type Agent,
  type EventRow,
  type OverlapRow,
  type Question,
  type Task,
} from '@/lib/conductor'

type Rec<T> = { recordId: string; data: T; createdAt: string; updatedAt: string }
type Run = <T>(name: string, params?: Record<string, unknown>) => Promise<T | null>
type Act = <T>(name: string, params: Record<string, unknown>, expected: Patch[]) => Promise<T | null>

export function StatusText({ status }: { status: string }) {
  const meta = TASK_STATUS[status] ?? { label: status, tone: 'text-muted-foreground' }
  return <span className={cn('text-[11px] font-semibold uppercase tracking-wide', meta.tone)}>{meta.label}</span>
}

const filesOf = (t: Task) => [...new Set([...(t.predictedFiles ?? []), ...(t.touchedFiles ?? [])])]

function GithubChips({ task }: { task: Task }) {
  const issue = safeGithubUrl(task.issueUrl)
  const pr = safeGithubUrl(task.prUrl)
  const prNumber = pr?.match(/\/pull\/(\d+)/)?.[1]
  return (
    <>
      {issue && task.issueNumber && (
        <a href={issue} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-primary/50 hover:text-foreground" title="GitHub issue">
          <CircleDot className="h-3 w-3" aria-hidden />#{task.issueNumber}
        </a>
      )}
      {pr && (
        <a href={pr} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] hover:border-primary/50', task.prState === 'merged' ? 'border-st-review/50 text-st-review' : 'border-border text-muted-foreground')} title="Pull request">
          <GitPullRequest className="h-3 w-3" aria-hidden />
          {prNumber ? `#${prNumber}` : 'PR'} {task.prState || ''}
        </a>
      )}
    </>
  )
}

export function TaskCard({
  task,
  agent,
  overlapCount,
  waitingOn,
  onOpen,
}: {
  task: Rec<Task>
  agent?: Rec<Agent>
  overlapCount: number
  waitingOn: string[]
  onOpen: () => void
}) {
  const files = filesOf(task.data)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}
      data-testid="task-card"
      className={cn(
        'w-full cursor-pointer rounded-lg border bg-background/60 p-3 text-left transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        overlapCount ? 'border-st-paused/50' : task.data.status === 'review' ? 'border-st-review/50' : 'border-border',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium leading-snug">{task.data.title}</span>
        {overlapCount > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-st-paused/15 px-1.5 py-0.5 text-[10px] font-semibold text-st-paused" title="Overlaps with another agent's work">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            {overlapCount}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <StatusText status={task.data.status} />
        {agent && <AgentChip name={agent.data.name} kind={agent.data.kind} />}
        <GithubChips task={task.data} />
      </div>
      {task.data.reviewNote && task.data.status !== 'done' && (
        <p className="mt-2 line-clamp-2 text-xs text-st-review">Changes requested: {task.data.reviewNote}</p>
      )}
      {task.data.status !== 'done' && !task.data.reviewNote && task.data.lastSummary && (
        <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{task.data.lastSummary}</p>
      )}
      {waitingOn.length > 0 && task.data.status === 'ready' && (
        <p className="mt-2 text-[11px] text-muted-foreground">Waits on: {waitingOn.join(', ')}</p>
      )}
      {files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {files.slice(0, 3).map((f) => (
            <Mono key={f} className="max-w-full truncate text-[10px]">{f}</Mono>
          ))}
          {files.length > 3 && <span className="text-[10px] text-muted-foreground">+{files.length - 3}</span>}
        </div>
      )}
    </div>
  )
}

const HISTORY_TONE: Record<string, string> = { review: 'text-st-review', complete: 'text-st-done', directive: 'text-st-paused', github: 'text-primary', assign: 'text-st-working' }

export function TaskDetail({ task, agent, deps, act, onClose }: { task: Rec<Task> | null; agent?: Rec<Agent>; deps: Array<Rec<Task>>; act: Act; onClose: () => void }) {
  const { records: history } = useQuery<EventRow>('events', { where: { taskId: task?.recordId ?? '__none__' }, orderBy: 'at', orderDir: 'desc', limit: 30 })
  const [changes, setChanges] = useState('')
  const [asking, setAsking] = useState(false)
  if (!task) return null
  const pr = safeGithubUrl(task.data.prUrl)
  const issue = safeGithubUrl(task.data.issueUrl)
  const touched = task.data.touchedFiles ?? []
  return (
    <Modal open onClose={onClose} size="lg">
      <Modal.Header>
        <Modal.Title>{task.data.title}</Modal.Title>
        <Modal.Description>
          <StatusText status={task.data.status} /> {agent && <>· {agent.data.name}</>} · updated {timeAgo(task.updatedAt)}
        </Modal.Description>
      </Modal.Header>
      <Modal.Body className="max-h-[70vh] overflow-y-auto text-sm">
        <div className="space-y-4" data-testid="task-detail">
        {(issue || pr) && (
          <div className="flex flex-wrap gap-2">
            {issue && (
              <a href={issue} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:border-primary/50">
                <CircleDot className="h-3.5 w-3.5" aria-hidden /> Issue #{task.data.issueNumber} <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            )}
            {pr && (
              <a href={pr} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:border-primary/50">
                <GitPullRequest className="h-3.5 w-3.5" aria-hidden /> Pull request · {task.data.prState || 'unknown'} <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            )}
          </div>
        )}

        {task.data.status === 'review' && (
          <div className="rounded-lg border border-st-review/50 bg-st-review/5 p-3" data-testid="review-box">
            <p className="text-xs font-semibold text-st-review">Waiting for review</p>
            <p className="mt-1 text-xs text-muted-foreground">Check the work{pr ? ' and its pull request' : ''}, then approve it or send it back. Merging the PR also approves it.</p>
            {asking ? (
              <form
                className="mt-2 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void act('requestChanges', { taskId: task.recordId, note: changes }, expected.requestChanges(task.recordId, changes))
                  setChanges('')
                  setAsking(false)
                  onClose()
                }}
              >
                <Textarea value={changes} onChange={(e) => setChanges(e.target.value)} rows={2} maxLength={1000} placeholder="What should change?" autoFocus aria-label="What should change?" />
                <div className="flex gap-2">
                  <Button size="sm" type="submit" disabled={!changes.trim()}>Send back</Button>
                  <Button size="sm" type="button" variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
                </div>
              </form>
            ) : (
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => { void act('approveTask', { taskId: task.recordId }, expected.approve(task.recordId)); onClose() }}>
                  <Check /> Approve
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setAsking(true)}>
                  <Undo2 /> Request changes
                </Button>
              </div>
            )}
          </div>
        )}
        {task.data.reviewNote && task.data.status !== 'done' && task.data.status !== 'review' && (
          <p className="rounded-lg border border-st-review/40 p-3 text-xs"><span className="font-semibold text-st-review">Changes requested:</span> {task.data.reviewNote}</p>
        )}

        {task.data.body && <p className="whitespace-pre-wrap">{task.data.body}</p>}
        {task.data.acceptance && (
          <div>
            <h4 className="text-xs font-semibold uppercase text-muted-foreground">Done when</h4>
            <p className="mt-1 whitespace-pre-wrap">{task.data.acceptance}</p>
          </div>
        )}
        <div>
          <h4 className="text-xs font-semibold uppercase text-muted-foreground">Files</h4>
          <ul className="mt-1 space-y-1">
            {filesOf(task.data).map((f) => (
              <li key={f} className="flex items-center gap-2">
                <Mono>{f}</Mono>
                <span className="text-[11px] text-muted-foreground">{touched.includes(f) ? 'touched' : 'predicted'}</span>
              </li>
            ))}
            {filesOf(task.data).length === 0 && <li className="text-muted-foreground">None predicted.</li>}
          </ul>
        </div>
        {deps.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase text-muted-foreground">Depends on</h4>
            <ul className="mt-1 list-disc pl-5">
              {deps.map((d) => (
                <li key={d.recordId}>{d.data.title} — <StatusText status={d.data.status} /></li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <h4 className="text-xs font-semibold uppercase text-muted-foreground">History</h4>
          {history.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">Nothing yet.</p>
          ) : (
            <ol className="mt-1 space-y-1.5 border-l border-border pl-3" data-testid="task-history">
              {history.map((e) => (
                <li key={e.recordId} className="text-xs leading-relaxed">
                  <span className="text-muted-foreground">{timeAgo(e.data.at)} · </span>
                  <span className={cn('font-medium', HISTORY_TONE[e.data.kind])}>{e.data.actorName}</span> {e.data.message}
                  {e.data.files && e.data.files.length > 0 && <span className="text-muted-foreground"> ({e.data.files.slice(0, 3).join(', ')})</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
        </div>
      </Modal.Body>
    </Modal>
  )
}

export function AgentsPanel({ agents, tasks, run, act }: { agents: Array<Rec<Agent>>; tasks: Array<Rec<Task>>; run: Run; act: Act }) {
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [reassign, setReassign] = useState<Rec<Agent> | null>(null)
  const order = { working: 0, paused: 1, idle: 2, offline: 3 } as Record<string, number>
  const sorted = [...agents].sort((a, b) => (order[a.data.status] ?? 9) - (order[b.data.status] ?? 9) || a.data.name.localeCompare(b.data.name))

  async function sendNote(e: FormEvent, agentId: string) {
    e.preventDefault()
    const text = note
    setNote('')
    setNoteFor(null)
    if (!(await run('sendDirective', { agentId, kind: 'note', text }))) {
      // Put the text back so nothing typed is lost.
      setNote(text)
      setNoteFor(agentId)
    }
  }

  if (!agents.length) {
    return <p className="text-sm text-muted-foreground">No agents yet. Connect one, or run the demo agents.</p>
  }
  return (
    <>
      <ul className="space-y-3" data-testid="agents-list">
        {sorted.map((a) => {
          const task = a.data.currentTaskId ? tasks.find((t) => t.recordId === a.data.currentTaskId) : undefined
          const st = AGENT_STATUS[a.data.status] ?? AGENT_STATUS.idle!
          return (
            <li key={a.recordId} className="rounded-lg border border-border bg-background/60 p-3" data-testid="agent-row">
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', st.dot, a.data.status === 'working' && 'animate-pulse')} aria-hidden />
                  <AgentChip name={a.data.name} kind={a.data.kind} />
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {st.label} · {timeAgo(a.data.lastSeenAt)}
                </span>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {a.data.kind === 'demo' ? 'Demo agent' : `${a.data.ownerName ?? 'Someone'}'s agent`}
                {task ? <> · on <span className="text-foreground">{task.data.title}</span></> : ' · no task'}
              </p>
              {a.data.lastSummary && <p className="mt-1 line-clamp-2 text-xs">{a.data.lastSummary}</p>}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {a.data.status === 'paused' ? (
                  <Button size="sm" variant="secondary" onClick={() => act('sendDirective', { agentId: a.recordId, kind: 'resume' }, expected.resume(a, task))}>
                    <Play /> Resume
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => act('sendDirective', { agentId: a.recordId, kind: 'pause' }, expected.pause(a, task))} disabled={a.data.status === 'offline'}>
                    <Pause /> Pause
                  </Button>
                )}
                {task && (
                  <Button size="sm" variant="ghost" onClick={() => setReassign(a)}>
                    <Undo2 /> Take task back
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => setNoteFor(noteFor === a.recordId ? null : a.recordId)}>
                  <MessageSquareText /> Note
                </Button>
              </div>
              {noteFor === a.recordId && (
                <form onSubmit={(e) => sendNote(e, a.recordId)} className="mt-2 flex gap-2">
                  <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={`Tell ${a.data.name}…`} maxLength={1000} autoFocus />
                  <Button size="icon" type="submit" aria-label="Send note" disabled={!note.trim()}>
                    <Send />
                  </Button>
                </form>
              )}
            </li>
          )
        })}
      </ul>
      <ConfirmModal
        open={!!reassign}
        onClose={() => setReassign(null)}
        onConfirm={async () => {
          const held = reassign?.data.currentTaskId ? tasks.find((t) => t.recordId === reassign.data.currentTaskId) : undefined
          if (reassign && held) void act('sendDirective', { agentId: reassign.recordId, kind: 'reassign' }, expected.reassign(reassign, held))
          setReassign(null)
        }}
        title="Take the task back?"
        description={reassign ? `${reassign.data.name} will be told to stop, and its task goes back to Ready for another agent.` : ''}
        confirmText="Take it back"
      />
    </>
  )
}

export function QuestionsPanel({ questions, agents, act, me }: { questions: Array<Rec<Question>>; agents: Array<Rec<Agent>>; act: Act; me: string }) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const open = questions.filter((q) => q.data.status === 'open')
  const answered = questions.filter((q) => q.data.status === 'answered').slice(-3).reverse()
  const name = (id: string) => agents.find((a) => a.recordId === id)?.data.name ?? 'An agent'

  async function answer(e: FormEvent, id: string) {
    e.preventDefault()
    const text = answers[id] ?? ''
    setAnswers((s) => ({ ...s, [id]: '' }))
    if (!(await act('answerQuestion', { questionId: id, answer: text }, expected.answer(id, text, me)))) setAnswers((s) => ({ ...s, [id]: text }))
  }

  if (!questions.length) return <p className="text-sm text-muted-foreground">Questions agents ask show up here.</p>
  return (
    <div className="space-y-3" data-testid="questions-list">
      {open.map((q) => (
        <form key={q.recordId} onSubmit={(e) => answer(e, q.recordId)} className="rounded-lg border border-primary/40 bg-primary/5 p-3">
          <p className="text-xs text-muted-foreground"><AgentChip name={name(q.data.agentId)} /> asks · {timeAgo(q.createdAt)}</p>
          <p className="mt-1.5 whitespace-pre-wrap text-sm">{q.data.text}</p>
          <div className="mt-2 flex gap-2">
            <Textarea
              rows={1}
              value={answers[q.recordId] ?? ''}
              onChange={(e) => setAnswers((s) => ({ ...s, [q.recordId]: e.target.value }))}
              placeholder="Your answer"
              maxLength={1000}
              className="min-h-9"
            />
            <Button type="submit" size="sm" disabled={!(answers[q.recordId] ?? '').trim()}>Answer</Button>
          </div>
        </form>
      ))}
      {answered.map((q) => (
        <div key={q.recordId} className="rounded-lg border border-border p-3 text-xs">
          <p className="text-muted-foreground">{name(q.data.agentId)}: {q.data.text}</p>
          <p className="mt-1">↳ {q.data.answeredByName}: {q.data.answer}</p>
        </div>
      ))}
    </div>
  )
}

export function OverlapsPanel({ overlaps, tasks, agents, act }: { overlaps: Array<Rec<OverlapRow>>; tasks: Array<Rec<Task>>; agents: Array<Rec<Agent>>; act: Act }) {
  const live = overlaps.filter((o) => o.data.status !== 'resolved')
  const task = (id: string) => tasks.find((t) => t.recordId === id)
  const agentOf = (id: string) => {
    const t = task(id)
    return t?.data.agentId ? agents.find((a) => a.recordId === t.data.agentId)?.data.name : undefined
  }
  if (!live.length) return <p className="text-sm text-muted-foreground">No overlaps. Agents are working in separate files.</p>
  return (
    <ul className="space-y-3" data-testid="overlaps-list">
      {live.map((o) => {
        const pairs = o.data.kind === 'import-neighbor' ? o.data.files.reduce<string[]>((acc, f, i) => (i % 2 ? [...acc.slice(0, -1), `${acc.at(-1)} ↔ ${f}`] : [...acc, f]), []) : o.data.files
        return (
          <li key={o.recordId} className={cn('rounded-lg border p-3', o.data.status === 'open' ? 'border-st-paused/50 bg-st-paused/5' : 'border-border')}>
            <p className="flex items-center gap-1.5 text-xs font-semibold text-st-paused">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              {o.data.kind === 'same-file' ? 'Same file' : 'Files that import each other'}
              {o.data.status === 'acknowledged' && <span className="font-normal text-muted-foreground">· acknowledged</span>}
            </p>
            <p className="mt-1.5 text-sm">
              {task(o.data.taskA)?.data.title ?? 'A task'} {agentOf(o.data.taskA) && <span className="text-muted-foreground">({agentOf(o.data.taskA)})</span>}
              <span className="text-muted-foreground"> and </span>
              {task(o.data.taskB)?.data.title ?? 'a task'} {agentOf(o.data.taskB) && <span className="text-muted-foreground">({agentOf(o.data.taskB)})</span>}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {pairs.slice(0, 4).map((f) => <Mono key={f} className="text-[10px]">{f}</Mono>)}
            </div>
            <div className="mt-2 flex gap-1.5">
              {o.data.status === 'open' && (
                <Button size="sm" variant="secondary" onClick={() => act('setOverlapStatus', { overlapId: o.recordId, status: 'acknowledged' }, expected.overlap(o.recordId, 'acknowledged'))}>Acknowledge</Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => act('setOverlapStatus', { overlapId: o.recordId, status: 'resolved' }, expected.overlap(o.recordId, 'resolved'))}>
                <CheckCheck /> Resolved
              </Button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

const EVENT_TONE: Record<string, string> = {
  overlap: 'text-st-paused',
  question: 'text-primary',
  complete: 'text-st-done',
  directive: 'text-st-review',
  assign: 'text-st-working',
}

export function ActivityFeed({ events }: { events: Array<Rec<EventRow>> }) {
  if (!events.length) return <p className="text-sm text-muted-foreground">Nothing yet.</p>
  return (
    <ol className="space-y-2.5" data-testid="activity-feed">
      {events.map((e) => (
        <li key={e.recordId} className="text-xs leading-relaxed">
          <span className="text-muted-foreground">{timeAgo(e.data.at)} · </span>
          <span className={cn('font-medium', EVENT_TONE[e.data.kind])}>{e.data.actorName}</span>{' '}
          <span>{e.data.message}</span>
          {e.data.files && e.data.files.length > 0 && (
            <span className="ml-1 text-muted-foreground">({e.data.files.slice(0, 3).join(', ')}{e.data.files.length > 3 ? '…' : ''})</span>
          )}
        </li>
      ))}
    </ol>
  )
}
