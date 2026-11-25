# Testing Conductor

Live site: **https://conductor.app.space**. Times below are Pacific.

## 0. One-time setup (Mac or Linux terminal)

```bash
git clone https://github.com/wilyan09007/deepspace_project.git
```
```bash
cd deepspace_project
```
```bash
git checkout claude/awesome-hypatia-2rmia9
```
```bash
npm install -g npm@11
```
```bash
npm install
```
```bash
npx deepspace auth login
```

Needs Node 22+. `auth login` opens your browser; sign in with the account that owns the app.

## 1. Free automated tests

All 95 unit tests, including the 9 timing rules (about 2 seconds):
```bash
npx vitest run
```

Only the time-based rules (fake clock, under a second): offline after 15 minutes (tasks given back after 2 hours are covered in the ops tests), invites expire after 7 days, PR refresh gap of 10 minutes, assistant limit resets on the hour, assistant proposals expire after 5 minutes, stuck plans retry after 3 minutes, daily limits reset, digest covers one day, demo time limit:
```bash
npx vitest run src/server/core/timing.test.ts
```

## 2. Browser tests (free; need 3 test accounts once)

Test-account emails are shared across all DeepSpace developers, so pick unique ones. The password is random and saved by the CLI on your machine.
```bash
openssl rand -base64 18 | npx deepspace test accounts create --email yourname-alice@deepspace.test --name Alice --password-stdin
```
```bash
openssl rand -base64 18 | npx deepspace test accounts create --email yourname-bob@deepspace.test --name Bob --password-stdin
```
```bash
openssl rand -base64 18 | npx deepspace test accounts create --email yourname-eve@deepspace.test --name Eve --password-stdin
```

Against a local copy of the app (starts it for you, about 2 minutes):
```bash
npx deepspace test run all
```

Against the live site (about 1 minute):
```bash
LIVE_URL=https://conductor.app.space npx playwright test -c tests/live.config.ts
```

## 3. Scheduled tasks on the live site (free)

See both tasks, their next run time and recent runs:
```bash
node scripts/cron.mjs
```

Run one now instead of waiting (same code the schedule runs):
```bash
node scripts/cron.mjs stale-sweep
```
```bash
node scripts/cron.mjs daily-digest
```

The digest runs on its own every day at 2:00 PM Pacific (22:00 UTC); the offline sweep every 5 minutes.

## 4. Be a coding agent from your terminal (free)

```bash
npx deepspace agent tools conductor --json
```
```bash
npx deepspace agent invoke conductor list_projects --input '{}' --json
```
```bash
npx deepspace agent invoke conductor register_agent --input '{"project":"gothinkster/react-redux-realworld-example-app","name":"me-test"}' --json
```

Copy the `agentId` from that reply into the next commands:
```bash
npx deepspace agent invoke conductor next_task --input '{"agent_id":"PASTE_AGENT_ID"}' --json
```
```bash
npx deepspace agent invoke conductor check_in --input '{"agent_id":"PASTE_AGENT_ID","status":"working","summary":"Trying Conductor","files":["src/reducer.js"]}' --json
```

Keep https://conductor.app.space open on that project's board while you run these: the agent and its task move in real time. Pause it from the board, then run `check_in` again to see the pause arrive.

## 5. Things that use your credits

Ask the live assistant one question (a few credits):
```bash
node scripts/ask.mjs "What is each agent doing?"
```

Red-team the assistant with 18 attack prompts (about 42 credits; limited to 20 assistant messages per hour, so run it at most once an hour):
```bash
node scripts/redteam.mjs
```

See what you've spent:
```bash
npx deepspace app usage
```

On the site itself: **New goal** (about 13 credits), **Ask** (a few credits), **Email me** on a digest (about 1 credit).

If a script says it can't sign in, refresh your login first:
```bash
npx deepspace auth whoami
```

## 6. GitHub sync on the live site

1. On a team page, click **connect your GitHub account** under the Add project box and approve on GitHub (**Reconnect GitHub** there or on the board changes which repos it can use).
2. Add a repo you can write to, then on its board open the **GitHub** panel and turn on **Mirror tasks as GitHub issues**.
3. Plan a goal (about 13 credits): one labelled issue per task appears on GitHub.
4. Take a task with the agent commands in section 4, then click **Sync now**: the issue's label changes to `conductor: in progress`.
5. Open a PR whose description includes `Closes #<issue>` and `Conductor-Task: <task id>` (the issue footer shows both), then **Sync now**: the task card shows the PR. Merging it approves the task, closes the issue and tells agents on the same files to rebase.
6. Close any mirrored issue on GitHub and **Sync now**: its task moves to Done.

## 7. Check the live app

```bash
npx deepspace logs --since 15m
```
```bash
npx deepspace releases
```
