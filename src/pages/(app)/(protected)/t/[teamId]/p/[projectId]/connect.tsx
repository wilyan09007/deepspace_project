import { Link, useParams } from 'react-router-dom'
import { useQuery } from 'deepspace'
import { Copy } from 'lucide-react'
import { Button, useToast } from '@/components/ui'
import { Crumbs, Loading, Mono, Page, Panel } from '@/components/conductor/Page'
import { APP_NAME } from '@/constants'
import type { Project, Team } from '@/lib/conductor'

function agentInstructions(projectId: string, repo: string): string {
  const cmd = (tool: string, input: string) => `npx deepspace agent invoke ${APP_NAME} ${tool} --input '${input}' --json`
  return `## Working with Conductor

This repository (${repo}) is coordinated with Conductor so several AI agents can work on it at once without colliding. Use these commands; they run as the developer signed in with \`npx deepspace auth login\`.

1. Once per session, register (pick a short name for yourself):
   ${cmd('register_agent', `{"project":"${projectId}","name":"claude-1"}`)}
   Keep the returned agent_id.
2. Get your task:
   ${cmd('next_task', '{"agent_id":"AGENT_ID"}')}
3. While working, check in every few minutes and whenever you start editing new files:
   ${cmd('check_in', '{"agent_id":"AGENT_ID","status":"working","summary":"what you are doing","files":["src/file.ts"]}')}
4. If you need a human decision:
   ${cmd('ask_human', '{"agent_id":"AGENT_ID","question":"..."}')}
5. Open a pull request. Its description must include the lines next_task gave you in "prInstructions":
   "Closes #<issue>" (when the task has a GitHub issue) and "Conductor-Task: <task id>". That links the PR to the task.
6. Submit the task for review (include the PR link only if you opened one):
   ${cmd('complete_task', '{"agent_id":"AGENT_ID","summary":"what changed","pr_url":"https://github.com/OWNER/REPO/pull/N"}')}
   A teammate approves it (or merging the PR does), or sends it back with notes. Then go back to step 2.

Rules:
- Every response may contain "directives" from your team. Obey them: "pause" = stop editing and check in again later; "reassign" = drop the task (leave shared files in a working state) and call next_task; "note"/"answer" = take it into account.
- "overlaps" name another agent working in or next to your files. Keep your changes there small and mention them in your check-in summary.
- Only edit the files your task needs. If you need others, list them in your next check-in.
- If next_task returns "history" or "reviewNote", someone worked on this task before or a reviewer asked for changes. Read them first and continue from there.
- A note saying another task "was merged" means files you're working on changed: pull the default branch and rebase before continuing.`
}

export default function ConnectPage() {
  const { teamId = '', projectId = '' } = useParams()
  const { success } = useToast()
  const { records: teams } = useQuery<Team>('teams', { where: { teamId } })
  const { records: projects, status } = useQuery<Project>('projects', { where: { teamId } })
  const project = projects.find((p) => p.recordId === projectId)

  if (status === 'loading') return <Page><Loading /></Page>
  if (!project) {
    return <Page><p className="mt-16 text-center text-sm text-muted-foreground">Project not found.</p></Page>
  }
  const repo = `${project.data.repoOwner}/${project.data.repoName}`
  const text = agentInstructions(projectId, repo)

  return (
    <Page>
      <Crumbs items={[{ label: 'Teams', to: '/teams' }, { label: teams[0]?.data.name ?? 'Team', to: `/t/${teamId}` }, { label: repo, to: `/t/${teamId}/p/${projectId}` }, { label: 'Connect an agent' }]} />
      <h1 className="text-2xl font-semibold tracking-tight">Connect a coding agent</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Claude Code, Codex or any agent that can run shell commands can join this board. It talks to Conductor through the DeepSpace CLI, signed in as you, so it can only see your teams.
      </p>

      <ol className="mt-6 space-y-4">
        <li>
          <Panel title="1. Sign in on the machine where the agent runs">
            <Mono className="text-xs">npx deepspace auth login</Mono>
            <p className="mt-2 text-xs text-muted-foreground">Use the same account you use here. Check it with <Mono>npx deepspace auth whoami</Mono>.</p>
          </Panel>
        </li>
        <li>
          <Panel
            title="2. Add these instructions to the repo's AGENTS.md or CLAUDE.md"
            action={
              <Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(text).then(() => success('Copied'))} data-testid="copy-instructions">
                <Copy /> Copy
              </Button>
            }
          >
            <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-lg bg-background p-3 font-mono text-[11px] leading-relaxed" data-testid="agent-instructions">{text}</pre>
          </Panel>
        </li>
        <li>
          <Panel title="3. Start your agent">
            <p className="text-sm">
              Ask it to "pick up a task from Conductor". It registers, takes the task that overlaps least with what others are doing, and shows up on the{' '}
              <Link to={`/t/${teamId}/p/${projectId}`} className="text-primary hover:underline">board</Link>.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Project id: <Mono>{projectId}</Mono>. To check the tools, run <Mono>npx deepspace agent tools {APP_NAME} --json</Mono>.
            </p>
          </Panel>
        </li>
      </ol>
    </Page>
  )
}
