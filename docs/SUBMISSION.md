# Submission kit

Copy what the form asks for. Fill in anything marked **[you]**.

## Name and one-liner

**Conductor** (see "Name" below before submitting)

> A shared, live control room for teams whose developers each run their own AI coding agent on the same repo: it splits work so agents don't collide, warns when they do, and lets anyone on the team steer anyone's agent.

## Links

- Live app: https://conductor.app.space
- Code: https://github.com/wilyan09007/deepspace_project — **[you]** make it public and put this work on the default branch first (see checklist)
- Docs in the repo: `README.md` (what/how/billing/guardrails), `docs/TESTING.md`, `docs/DECISIONS.md` (every product decision and who made it), `docs/BUILD_NOTES.md` (the build plan as it evolved)

## The problem

AI coding agents are now good enough that every developer on a team runs one, often several. On a shared repo that goes wrong quickly. Two people's agents rewrite the same file, nobody knows what anyone else's agent is doing, and when an agent needs a decision it just guesses. Existing tools either run many agents for **one** person on **one** machine, or lock files so agents block each other.

## What it does

1. **Plan:** describe a goal; Conductor reads the GitHub repo and splits it into tasks, each with the files it will likely touch and what it depends on.
2. **Hand out work so agents stay apart:** each developer's agent (Claude Code, Codex, anything that runs a command) asks for a task and gets the one that overlaps least with what everyone else's agents are doing.
3. **Warn, don't block:** when two agents end up in the same file, or in files that import each other, both agents and the whole team are told who else is there and what they're doing.
4. **Steer anyone's agent:** pause, resume, take a task back, send a note, answer an agent's question. The agent gets it on its next check-in.
5. **Review and GitHub:** finished work waits for a human to approve it (or a merged PR). Tasks can be mirrored as GitHub issues with status labels; PRs link themselves to tasks; closing an issue on GitHub finishes the task.
6. **Inbox and safety nets:** one page of everything waiting on you; merge alerts tell agents to rebase; tasks held by agents that went offline go back to the pool.
7. **A guarded assistant:** "what is each agent doing?" — it only talks about your board, ignores instructions hidden in agent-written text, and never acts without your "yes" (passed an 18-prompt red-team set on the live site).

## How it uses DeepSpace

| Need | DeepSpace piece |
|---|---|
| Sign-in and each user paying for their own AI | built-in auth; the caller's token bills them |
| Team-private data, live board | RecordRoom collections with team permissions + live subscriptions |
| Agents talking to the app | agent tools (`registerAgent`), invoked through the DeepSpace CLI |
| Demo agents | JobRoom background job |
| Offline-agent sweep, daily digest | CronRoom scheduled tasks |
| Planning, assistant | Claude through DeepSpace's AI proxy |
| Repo reading, issues, PRs | `github/*` integration and each user's own GitHub connection (Composio) |
| Digest email | `email/send` |

## How to try it (2 minutes, free)

1. Open https://conductor.app.space → **Open the app** → sign in.
2. **New team** → create one.
3. On the team page, click **Load sample** (a plan captured from a real planner run).
4. Click **Run demo agents**. Three scripted agents take tasks, check in, collide in one file, and ask a question.
5. Answer the question, pause an agent, approve a task in **Review**, open the **Inbox**. Invite a second account to watch it update live.

With credits: add any public repo and click **New goal** (~13 credits), or connect GitHub to mirror tasks as issues.

## Built with an AI agent

I made the product decisions; Claude Code built it. Every decision is in `docs/DECISIONS.md` with who made it. The build plan and every change to it, including bugs that testing caught, are in `docs/BUILD_NOTES.md`. Tests: 101 unit, 19 browser (local), plus live tests and a live red-team of the assistant.

## Name

"Conductor" is also the name of a well-known YC-backed Mac app (Melty Labs, conductor.build) that runs several Claude Code agents in parallel for one developer. **[you]** Keep the name and acknowledge the clash, or rename before submitting (a DeepSpace rename moves the URL; data stays).

## Pre-submission checklist

- [ ] **[you]** Make the GitHub repo public (decision #10).
- [ ] **[you]** Put this work on the default branch. The repo's default is currently `claude/eloquent-ptolemy-w86k06`, which has only the early work; everything is on `claude/awesome-hypatia-2rmia9`. Merge a PR, or change the default branch in GitHub settings.
- [ ] **[you]** Decide on the name (above).
- [ ] Optional: delete the leftover test branch `conductor-test/pr-link`. Test issues #1–#2 and PR #3 on the repo are real examples of the GitHub sync; keep or close them.
- [ ] Optional: refresh the README screenshots (they predate the Review column, GitHub panel and Inbox).
