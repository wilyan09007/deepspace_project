# Conductor — spec (draft v1)

Conductor is a shared control room for a team whose developers each run AI
coding agents (Claude Code, Codex, …) on the same repository. A human writes a
goal; Conductor plans it into tasks with the files each is likely to touch,
hands tasks to agents in an order that keeps their work apart, warns agents and
humans when work overlaps, and lets humans steer any agent from the board.

## Core loop (what must work on the live app)

1. Sign in, create a team, add a project (public GitHub repo `owner/name`).
2. Write a goal ("Add dark mode to the settings page").
3. **Planner job** reads the repo and produces 3–10 tasks, each with a
   description, acceptance check, predicted files, and dependencies. Progress
   streams to the page.
4. Agents (real ones through the CLI, or demo agents) call `next_task`, work,
   and `check_in` with status and the files they are touching.
5. The board updates live: agents, tasks, activity, overlap warnings, questions.
6. A human pauses, resumes, reassigns, or answers a question; the agent gets it
   on its next check-in.
7. Tasks finish with a PR link; PR status is pulled from GitHub.
8. A daily digest summarises the team's day.

## Data model (collections in the app RecordRoom)

All team-owned collections use `teamField: 'teamId'` and the built-in `'team'`
permission level, so only members of that team can read or change them.

| Collection | Key fields |
|---|---|
| `users` | scaffold collection, unchanged |
| `teams` | name, ownerId |
| `team_members` | teamId, userId, role (`owner`/`member`), status (`active`) — built-in membership table |
| `team_invites` | teamId, code, createdBy, expiresAt, usedBy |
| `projects` | teamId, repoOwner, repoName, defaultBranch, description |
| `goals` | teamId, projectId, title, body, status (`planning`/`planned`/`active`/`done`/`failed`), planJobId, planError |
| `tasks` | teamId, projectId, goalId, title, body, acceptance, predictedFiles[], dependsOn[], order, status (`ready`/`assigned`/`in_progress`/`blocked`/`paused`/`review`/`done`), agentId, touchedFiles[], prUrl, prState |
| `agents` | teamId, name, ownerUserId, kind (`cli`/`demo`), status (`idle`/`working`/`paused`/`offline`), currentTaskId, lastSeenAt, lastSummary |
| `directives` | teamId, agentId, kind (`pause`/`resume`/`reassign`/`answer`/`note`), text, createdBy, deliveredAt |
| `questions` | teamId, agentId, taskId, text, answer, answeredBy, status (`open`/`answered`) |
| `overlaps` | teamId, projectId, taskA, taskB, files[], kind (`same-file`/`import-neighbor`), status (`open`/`acknowledged`/`resolved`) |
| `events` | teamId, projectId, agentId, taskId, kind, message, files[] — the activity feed |
| `digests` | teamId, date, body, sentTo[] |

## Overlap without locks (decision #6)

- Overlap = two active tasks whose files (predicted ∪ touched) intersect
  directly, or where one file imports the other.
- Import edges come from parsing the predicted files only (fetched with
  `github/get-repository-contents`), not the whole repo.
- **Scheduling:** `next_task` picks a ready task whose dependencies are done,
  ranked by least overlap with work already in progress.
- **Warnings, not blocks:** every `check_in` response lists open overlaps with
  who else is in those files and what they are doing; the board shows the same.
  A human can acknowledge or resolve an overlap.

## Agent tools (one definition via `registerAgent`)

Used by local agents through `npx deepspace agent invoke conductor <tool>` and
by the demo agents server-side.

| Tool | Does |
|---|---|
| `register_agent` | Create or reuse an agent identity for the caller in a team |
| `next_task` | Assign the best ready task (or report nothing to do) |
| `check_in` | Report status, summary, touched files → returns pending directives, overlap warnings, answers |
| `ask_human` | Post a question to the board |
| `complete_task` | Mark done with summary and optional PR URL |
| `get_task` | Read one task with its context |

A copyable `AGENTS.md` snippet on the "Connect an agent" page tells an agent the
loop: register → next_task → work, check_in every step → complete_task.

## Platform pieces used

| Need | DeepSpace built-in |
|---|---|
| Accounts, sign-in | Built-in auth |
| Team-only data | RecordRoom + `'team'` permission + `team_members` |
| Live board | Record subscriptions (`useQuery`) |
| Who's viewing | PresenceRoom |
| Planning, demo agents | JobRoom (`src/jobs.ts`, `useJobs` progress) |
| Digest, stale-agent sweep, PR refresh | CronRoom (`src/cron.ts`) |
| Agent tools | `registerAgent` + `buildTools` |
| Privileged writes (assignment, overlap calc) | Server actions |
| Repo reading, PR status | `github/*` integration |
| Planning and summaries | Claude through `createDeepSpaceAI` |
| Digest delivery | `email/send` |

Left out on purpose: payments (no paid tier in scope), file storage (nothing to
upload), Yjs/canvas (no shared freeform editing), voice (no use in the loop).

## Demo mode

"Run demo" on a project starts a background job that drives 3 demo agents
through the same tool functions: they take tasks, check in with files, create
at least one overlap, ask one question, and obey pause/resume/reassign. Pacing
uses `ctx.continue(state, { afterMs })` so the run is visible in real time.

## Failure and empty states

No teams, no projects, repo not found or private, planner failed (retry),
no ready tasks, agent offline, directive to an offline agent, job canceled.

## Tests

- Unit: scheduler ranking, overlap detection, import parsing, plan validation.
- API: each agent tool, including a caller from another team being refused.
- Two-user: member A's directive reaches agent of member B; outsider sees nothing.
- Live smoke on the deploy: create team → project → goal → demo run.

## Build order

1. Spikes: planner quality and cost on 2–3 real repos; one tool called from a
   local agent through the CLI.
2. Schemas + permissions, team/invite flow, first deploy.
3. Agent tools + scheduler + overlap engine.
4. Planner job + board UI.
5. Directives, questions, demo mode.
6. Cron digest, PR status, landing page, design pass.
7. Tests, live smoke, README and submission note.
