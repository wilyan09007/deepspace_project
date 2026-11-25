/**
 * Landing page — static and prerendered (no auth or realtime here). Keep it
 * renderable without a browser: no window/document during render.
 */

import { Link } from 'react-router-dom'
import { AlertTriangle, Bot, GitBranch, Hand, Map as MapIcon, MessageSquareText, Sparkles } from 'lucide-react'
import { Seo } from '../components/Seo'
import { seo } from '../seo'

const STEPS = [
  {
    icon: MapIcon,
    title: 'Plan a goal',
    body: 'Describe what you want. Squadboard reads the public GitHub repo and splits the goal into tasks, each with the files it will likely touch and what it depends on.',
  },
  {
    icon: Bot,
    title: 'Agents pick up work',
    body: 'Each developer points their own Claude Code, Codex or other agent at the board. Every agent gets the ready task that overlaps least with what the others are doing.',
  },
  {
    icon: Hand,
    title: 'Humans steer',
    body: 'Pause, resume or take a task back from any agent, answer their questions, and send notes. Agents receive it on their next check-in.',
  },
]

const FEATURES = [
  { icon: AlertTriangle, title: 'Overlap warnings, not locks', body: 'When two agents edit the same file, or files that import each other, both agents and the board are told who else is there and what they are doing.' },
  { icon: GitBranch, title: 'Pull requests on the board', body: 'Agents finish tasks with a PR link; its open, merged or closed state shows next to the task.' },
  { icon: MessageSquareText, title: 'Questions and a daily digest', body: 'Agents can ask the team a question instead of guessing. A summary of each day is posted to the team page and, if you want, emailed.' },
  { icon: Sparkles, title: 'An assistant that stays on topic', body: '“What is each agent doing?” — a guarded assistant answers from your board only, and never acts without your explicit yes.' },
]

export default function Landing() {
  return (
    <>
      <Seo {...seo} path="/" />
      <div data-testid="static-landing" className="min-h-screen bg-background text-foreground">
        <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
          <span className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground" aria-hidden>
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <path d="M4 20 L17 7" />
                <circle cx="18.5" cy="5.5" r="2" fill="currentColor" stroke="none" />
              </svg>
            </span>
            Squadboard
          </span>
          <Link to="/teams" className="rounded-full border border-border px-4 py-1.5 text-sm hover:border-primary/60">
            Open the app
          </Link>
        </header>

        <section className="mx-auto max-w-6xl px-6 pb-16 pt-10 sm:pt-16">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">For teams running AI coding agents</p>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.1] tracking-tight sm:text-6xl">
            Every agent on your repo, on one board.
          </h1>
          <p className="mt-5 max-w-2xl text-lg text-muted-foreground">
            When each developer runs their own coding agent, agents collide in the same files and nobody can see what the others are doing. Squadboard plans the work, hands it out so agents stay apart, warns when they overlap, and lets anyone on the team steer any agent.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/teams" className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90">
              Start a team
            </Link>
            <a href="#how" className="inline-flex items-center rounded-full border border-border px-5 py-2.5 text-sm hover:border-primary/60">
              How it works
            </a>
          </div>

          {/* Illustration of the board (static, not live data). */}
          <div className="mt-14 overflow-hidden rounded-2xl border border-border bg-card p-4 sm:p-6" aria-hidden>
            <div className="grid gap-3 sm:grid-cols-4">
              {[
                { col: 'Ready', cards: [['Document the theme API', 'text-st-ready', '']] },
                { col: 'In progress', cards: [['Add dark palette tokens', 'text-st-working', 'claude-ana'], ['Settings toggle', 'text-st-working', 'codex-ben']] },
                { col: 'Paused', cards: [['Persist preference', 'text-st-paused', 'claude-raj']] },
                { col: 'Done', cards: [['Audit hard-coded colors', 'text-st-done', 'codex-ben']] },
              ].map(({ col, cards }) => (
                <div key={col} className="rounded-xl border border-border bg-background/60 p-2">
                  <p className="px-1 pb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{col}</p>
                  {cards.map(([title, tone, agent]) => (
                    <div key={title} className="mb-2 rounded-lg border border-border bg-card p-2.5">
                      <p className="text-xs font-medium">{title}</p>
                      <p className={`mt-1 text-[10px] font-semibold uppercase ${tone}`}>{agent || 'waiting'}</p>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-st-paused/50 bg-st-paused/10 px-3 py-2 text-xs text-st-paused">
              <AlertTriangle className="h-3.5 w-3.5" /> claude-ana and codex-ben are both editing <code className="font-mono">src/theme.ts</code>
            </div>
          </div>
        </section>

        <section id="how" className="border-t border-border">
          <div className="mx-auto grid max-w-6xl gap-8 px-6 py-16 md:grid-cols-3">
            {STEPS.map(({ icon: Icon, title, body }, i) => (
              <div key={title}>
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <span className="grid h-7 w-7 place-items-center rounded-full bg-primary/15 text-xs text-primary">{i + 1}</span>
                  <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
                  {title}
                </p>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-t border-border bg-card/40">
          <div className="mx-auto grid max-w-6xl gap-6 px-6 py-16 sm:grid-cols-2">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-xl border border-border bg-background/60 p-5">
                <Icon className="h-5 w-5 text-primary" aria-hidden />
                <h2 className="mt-3 font-semibold">{title}</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="border-t border-border">
          <div className="mx-auto max-w-6xl px-6 py-16">
            <h2 className="text-2xl font-semibold tracking-tight">Any agent that can run a command can join</h2>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Agents talk to Squadboard through the DeepSpace CLI, signed in as their developer. Add a short block to your repo's <code className="font-mono">AGENTS.md</code> and they register, take tasks, check in and finish with a PR.
            </p>
            <pre className="mt-6 overflow-x-auto rounded-xl border border-border bg-card p-4 font-mono text-xs leading-relaxed text-foreground/90">
{`npx deepspace agent invoke squadboard next_task --input '{"agent_id":"…"}' --json
npx deepspace agent invoke squadboard check_in  --input '{"agent_id":"…","summary":"Adding the toggle","files":["src/settings/Toggle.tsx"]}' --json`}
            </pre>
            <p className="mt-6 text-sm text-muted-foreground">
              Try it without connecting anything: run the built-in demo agents on a plan and steer them from the board. AI features (planning, the assistant) use your own DeepSpace credits.
            </p>
            <Link to="/teams" className="mt-6 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90">
              Open Squadboard
            </Link>
          </div>
        </section>

        <footer className="border-t border-border py-8 text-center text-xs text-muted-foreground">Squadboard · built on DeepSpace</footer>
      </div>
    </>
  )
}
