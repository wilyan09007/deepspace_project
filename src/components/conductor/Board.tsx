/**
 * Board panels. Everything here renders records that agents wrote, so it is
 * treated as plain text: no HTML, and only github.com links become links.
 */

import { useState, type FormEvent } from 'react'
import { AlertTriangle, CheckCheck, ExternalLink, GitPullRequest, MessageSquareText, Pause, Play, Send, Undo2 } from 'lucide-react'
import { Button, ConfirmModal, Input, Modal, Textarea } from '@/components/ui'
import { cn } from '@/lib/utils'
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

export function StatusText({ status }: { status: string }) {
  const meta = TASK_STATUS[status] ?? { label: status, tone: 'text-muted-foreground' }
  return <span className={cn('text-[11px] font-semibold uppercase tracking-wide', meta.tone)}>{meta.label}</span>
}

const filesOf = (t: Task) => [...new Set([...(t.predictedFiles ?? []), ...(t.touchedFiles ?? [])])]

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
  const pr = safeGithubUrl(task.data.prUrl)
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="task-card"
      className={cn(
        'w-full rounded-lg border bg-background/60 p-3 text-left transition-colors hover:border-primary/40',
        overlapCount ? 'border-st-paused/50' : 'border-border',
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
        {pr && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <GitPullRequest className="h-3 w-3" aria-hidden /> PR {task.data.prState || ''}
          </span>
        )}
      </div>
      {task.data.status !== 'done' && task.data.lastSummary && (
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
    </button>
  )
}

export function TaskDetail({ task, agent, deps, onClose }: { task: Rec<Task> | null; agent?: Rec<Agent>; deps: Array<Rec<Task>>; onClose: () => void }) {
  if (!task) return null
  const pr = safeGithubUrl(task.data.prUrl)
  const touched = task.data.touchedFiles ?? []
  return (
    <Modal open onClose={onClose} size="lg">
      <Modal.Header>
        <Modal.Title>{task.data.title}</Modal.Title>
        <Modal.Description>
          <StatusText status={task.data.status} /> {agent && <>· {agent.data.name}</>} · updated {timeAgo(task.updatedAt)}
        </Modal.Description>
      </Modal.Header>
      <Modal.Body className="space-y-4 text-sm">
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
        {task.data.lastSummary && (
          <div>
            <h4 className="text-xs font-semibold uppercase text-muted-foreground">Latest from the agent</h4>
            <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{task.data.lastSummary}</p>
          </div>
        )}
        {pr && (
          <a href={pr} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-primary hover:underline">
            <GitPullRequest className="h-4 w-4" aria-hidden /> Pull request ({task.data.prState || 'unknown'}) <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        )}
      </Modal.Body>
    </Modal>
  )
}

export function AgentsPanel({ agents, tasks, run, pending }: { agents: Array<Rec<Agent>>; tasks: Array<Rec<Task>>; run: Run; pending: string | null }) {
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [reassign, setReassign] = useState<Rec<Agent> | null>(null)
  const order = { working: 0, paused: 1, idle: 2, offline: 3 } as Record<string, number>
  const sorted = [...agents].sort((a, b) => (order[a.data.status] ?? 9) - (order[b.data.status] ?? 9) || a.data.name.localeCompare(b.data.name))

  async function sendNote(e: FormEvent, agentId: string) {
    e.preventDefault()
    if (await run('sendDirective', { agentId, kind: 'note', text: note })) {
      setNote('')
      setNoteFor(null)
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
                  <Button size="sm" variant="secondary" onClick={() => run('sendDirective', { agentId: a.recordId, kind: 'resume' })} disabled={!!pending}>
                    <Play /> Resume
                  </Button>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => run('sendDirective', { agentId: a.recordId, kind: 'pause' })} disabled={!!pending || a.data.status === 'offline'}>
                    <Pause /> Pause
                  </Button>
                )}
                {task && (
                  <Button size="sm" variant="ghost" onClick={() => setReassign(a)} disabled={!!pending}>
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
          if (reassign) await run('sendDirective', { agentId: reassign.recordId, kind: 'reassign' })
          setReassign(null)
        }}
        title="Take the task back?"
        description={reassign ? `${reassign.data.name} will be told to stop, and its task goes back to Ready for another agent.` : ''}
        confirmText="Take it back"
      />
    </>
  )
}

export function QuestionsPanel({ questions, agents, run }: { questions: Array<Rec<Question>>; agents: Array<Rec<Agent>>; run: Run }) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const open = questions.filter((q) => q.data.status === 'open')
  const answered = questions.filter((q) => q.data.status === 'answered').slice(-3).reverse()
  const name = (id: string) => agents.find((a) => a.recordId === id)?.data.name ?? 'An agent'

  async function answer(e: FormEvent, id: string) {
    e.preventDefault()
    if (await run('answerQuestion', { questionId: id, answer: answers[id] })) setAnswers((s) => ({ ...s, [id]: '' }))
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

export function OverlapsPanel({ overlaps, tasks, agents, run }: { overlaps: Array<Rec<OverlapRow>>; tasks: Array<Rec<Task>>; agents: Array<Rec<Agent>>; run: Run }) {
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
                <Button size="sm" variant="secondary" onClick={() => run('setOverlapStatus', { overlapId: o.recordId, status: 'acknowledged' })}>Acknowledge</Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => run('setOverlapStatus', { overlapId: o.recordId, status: 'resolved' })}>
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
