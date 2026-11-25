#!/usr/bin/env node
/**
 * Ask the live Squadboard assistant one question as the developer signed in
 * with the DeepSpace CLI (billed to them). Run `npx deepspace auth whoami` first.
 *
 *   node scripts/ask.mjs "What is each agent doing?" [--url https://squadboard.app.space] [--model claude-sonnet-5-5]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i > -1 ? args[i + 1] : fallback
}
const question = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
if (!question) {
  console.error('Usage: node scripts/ask.mjs "your question"')
  process.exit(2)
}
const url = opt('url', 'https://squadboard.app.space')
const raw = readFileSync(`${homedir()}/.deepspace/token`, 'utf8').trim()
let token = raw
try {
  const j = JSON.parse(raw)
  token = j.accessToken ?? j.access_token ?? j.token ?? j.jwt ?? raw
} catch {}
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
const { chat } = await (await fetch(`${url}/api/ai/chats`, { method: 'POST', headers, body: JSON.stringify({ title: question.slice(0, 40) }) })).json()
const res = await fetch(`${url}/api/ai/chat`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ chatId: chat.recordId, userMessageId: `ask-${Date.now()}`, content: question, modelId: opt('model', 'claude-sonnet-5-5') }),
})
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${await res.text()}`)
  process.exit(1)
}
let text = ''
const tools = new Set()
for (const line of (await res.text()).split('\n')) {
  if (!line.startsWith('data: ')) continue
  try {
    const ev = JSON.parse(line.slice(6))
    if (ev.type === 'text-delta') text += ev.delta
    if (ev.type === 'tool-input-start' || ev.type === 'tool-input-available') tools.add(ev.toolName)
  } catch {}
}
if (tools.size) console.log(`(looked up: ${[...tools].join(', ')})\n`)
console.log(text.trim())
