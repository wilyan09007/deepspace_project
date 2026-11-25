/**
 * The expected result of each user action, shown immediately by `act()`.
 * These mirror what src/server/core/ops.ts writes; if the server disagrees or
 * the action fails, the live records win.
 */

import type { Patch } from './optimistic'
import type { Agent, Task } from './conductor'

type Rec<T> = { recordId: string; data: T }

export const expected = {
  pause(agent: Rec<Agent>, task?: Rec<Task>): Patch[] {
    return [
      { collection: 'agents', id: agent.recordId, data: { status: 'paused' } },
      ...(task && task.data.status !== 'done' ? [{ collection: 'tasks', id: task.recordId, data: { status: 'paused' } }] : []),
    ]
  },
  resume(agent: Rec<Agent>, task?: Rec<Task>): Patch[] {
    return [
      { collection: 'agents', id: agent.recordId, data: { status: task ? 'working' : 'idle' } },
      ...(task?.data.status === 'paused' ? [{ collection: 'tasks', id: task.recordId, data: { status: 'in_progress' } }] : []),
    ]
  },
  reassign(agent: Rec<Agent>, task: Rec<Task>): Patch[] {
    return [
      { collection: 'tasks', id: task.recordId, data: { status: 'ready', agentId: null } },
      { collection: 'agents', id: agent.recordId, data: { currentTaskId: null, status: agent.data.status === 'paused' ? 'paused' : 'idle' } },
    ]
  },
  answer(questionId: string, answer: string, by: string): Patch[] {
    return [{ collection: 'questions', id: questionId, data: { status: 'answered', answer, answeredByName: by } }]
  },
  overlap(overlapId: string, status: 'acknowledged' | 'resolved'): Patch[] {
    return [{ collection: 'overlaps', id: overlapId, data: { status } }]
  },
  approve(taskId: string): Patch[] {
    return [{ collection: 'tasks', id: taskId, data: { status: 'done' } }]
  },
  requestChanges(taskId: string, note: string): Patch[] {
    return [{ collection: 'tasks', id: taskId, data: { status: 'ready', agentId: null, reviewNote: note } }]
  },
  demo(goalId: string, demoState: 'running' | 'stopping'): Patch[] {
    return [{ collection: 'goals', id: goalId, data: { demoState } }]
  },
  retryPlan(goalId: string): Patch[] {
    return [{ collection: 'goals', id: goalId, data: { status: 'planning', planStage: 'queued', planError: '' } }]
  },
  mirroring(projectId: string, on: boolean): Patch[] {
    return [{ collection: 'projects', id: projectId, data: { mirrorIssues: on ? 1 : 0 } }]
  },
}
