// Aside relay: the one place that holds your Notion token and model key.
// The glasses app talks to it over a small JSON API.
//
//   NOTION_TOKEN=ntn_... node server/relay.mjs
//
// Optional environment:
//   NOTION_DATA_SOURCE_ID  task list to use (otherwise the best match is found by search)
//   OPENROUTER_API_KEY     turns on model-written drafts and briefs
//   OPENROUTER_MODEL       default anthropic/claude-haiku-5.5
//   STT_URL, STT_KEY, STT_MODEL   OpenAI-compatible transcription endpoint for voice capture
//   PORT (8788), RELAY_TOKEN (printed if not set), ALLOW_ORIGIN (*), TZ_OFFSET_MINUTES (0)
//
// Node 22+, no dependencies.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

import { addDays, friendly, isIsoDate, iso } from '../shared/dates.mjs'
import { Assistant } from './llm.mjs'
import { Notion } from './notion.mjs'

const env = process.env
const PORT = Number(env.PORT ?? 8788)
const TOKEN = env.RELAY_TOKEN ?? randomBytes(12).toString('hex')
const ORIGIN = env.ALLOW_ORIGIN ?? '*'
const OFFSET = Number(env.TZ_OFFSET_MINUTES ?? 0)

/** "Today" in the user's time zone, as YYYY-MM-DD. */
export const todayIn = (offsetMinutes, now = Date.now()) => iso(new Date(now + offsetMinutes * 60_000))

export function createRelay({ notion, assistant, dataSourceId = null, stt = null, fetch: fetcher = fetch, today = () => todayIn(OFFSET) }) {
  let source = dataSourceId

  async function sourceId() {
    if (source) return source
    const [best] = await notion.sources()
    if (!best) throw new Error('No task list found. Share a database with a title and a Status or checkbox, or set NOTION_DATA_SOURCE_ID.')
    source = best.id
    return source
  }

  const decorate = (task, now) => ({ ...task, when: friendly(task.due, now), overdue: Boolean(task.due && task.due < now) })

  return {
    'GET /status': async () => {
      const schema = await notion.schema(await sourceId())
      return { list: schema.name, due: Boolean(schema.due), model: assistant.enabled ? assistant.model : null, voice: Boolean(stt?.url) }
    },

    'GET /today': async () => {
      const now = today()
      const tasks = await notion.today(await sourceId(), now)
      return { today: now, tasks: tasks.map((task) => decorate(task, now)) }
    },

    'POST /done': async ({ id }) => {
      await notion.complete(await sourceId(), String(id))
      return { ok: true }
    },

    'POST /move': async ({ id, to }) => {
      const now = today()
      const due = to === 'tomorrow' ? addDays(now, 1) : to === 'week' ? addDays(now, 7) : to
      if (!isIsoDate(due)) throw new Error('Unknown date')
      await notion.reschedule(await sourceId(), String(id), due)
      return { ok: true, due, when: friendly(due, now) }
    },

    /** Sentence in, draft out. Nothing is written to Notion here. */
    'POST /draft': async ({ text }) => {
      const spoken = String(text ?? '').trim().slice(0, 600)
      if (!spoken) throw new Error('Nothing to capture')
      const now = today()
      const draft = await assistant.draft(spoken, now)
      return { ...draft, when: friendly(draft.due, now), heard: spoken }
    },

    'POST /save': async ({ title, due, note }) => {
      const clean = String(title ?? '').trim()
      if (!clean) throw new Error('A task needs a title')
      const now = today()
      const task = await notion.create(await sourceId(), { title: clean, due: isIsoDate(due) ? due : null, note: String(note ?? '') })
      return decorate(task, now)
    },

    'POST /brief': async ({ id, title }) => assistant.brief(String(title ?? ''), await notion.content(String(id))),

    /** WAV in, text out, via the configured transcription service. */
    'POST /transcribe': async (_, audio) => {
      if (!stt?.url) throw new Error('Voice is not configured on the relay')
      if (!audio?.length) throw new Error('No audio received')
      const form = new FormData()
      form.append('file', new Blob([audio], { type: 'audio/wav' }), 'capture.wav')
      form.append('model', stt.model || 'whisper-1')
      const response = await fetcher(stt.url, { method: 'POST', headers: stt.key ? { Authorization: `Bearer ${stt.key}` } : {}, body: form })
      if (!response.ok) throw new Error(`Speech service answered ${response.status}`)
      return { text: String((await response.json()).text ?? '').trim() }
    },
  }
}

const authorised = (header, token) => {
  const given = Buffer.from(String(header ?? '').replace(/^Bearer /, ''))
  const wanted = Buffer.from(token)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

export function serve(routes, { token, origin = '*' }) {
  return createServer(async (request, response) => {
    const headers = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Content-Type': 'application/json' }
    const reply = (status, payload) => response.writeHead(status, headers).end(JSON.stringify(payload))
    if (request.method === 'OPTIONS') return response.writeHead(204, { ...headers, 'Access-Control-Max-Age': '86400' }).end()
    if (!authorised(request.headers.authorization, token)) return reply(401, { error: 'Wrong or missing relay token' })

    const route = routes[`${request.method} ${new URL(request.url, 'http://relay').pathname}`]
    if (!route) return reply(404, { error: 'Not found' })
    try {
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 4_000_000) return reply(413, { error: 'Body too large' })
        chunks.push(chunk)
      }
      const raw = Buffer.concat(chunks)
      const isJson = String(request.headers['content-type'] ?? '').includes('json')
      reply(200, await route(isJson && raw.length ? JSON.parse(raw.toString('utf8')) : {}, isJson ? null : raw))
    } catch (error) {
      reply(400, { error: error.message })
    }
  })
}

// Start only when run directly, so tests can import the pieces.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const notion = new Notion({ token: env.NOTION_TOKEN })
  const assistant = new Assistant({ key: env.OPENROUTER_API_KEY, model: env.OPENROUTER_MODEL || undefined })
  const stt = env.STT_URL ? { url: env.STT_URL, key: env.STT_KEY ?? '', model: env.STT_MODEL ?? 'whisper-1' } : null
  const routes = createRelay({ notion, assistant, dataSourceId: env.NOTION_DATA_SOURCE_ID || null, stt })
  serve(routes, { token: TOKEN, origin: ORIGIN }).listen(PORT, () => {
    console.log(`Aside relay on http://localhost:${PORT}`)
    console.log(`Relay token: ${TOKEN}`)
    console.log(`Drafts and briefs: ${assistant.enabled ? assistant.model : 'built-in rules (set OPENROUTER_API_KEY for a model)'}`)
  })
}
