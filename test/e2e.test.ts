// The whole path in one process: app controller -> relay client -> real HTTP ->
// relay -> Notion client -> an in-memory stand-in for the Notion API that
// applies filters, sorts and updates the way the documentation describes.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'

import { Assistant } from '../server/llm.mjs'
import { Notion } from '../server/notion.mjs'
import { createRelay, serve } from '../server/relay.mjs'
import { RelaySource } from '../src/core/tasks.ts'
import { App } from '../src/ui/app.ts'
import { ACTIONS } from '../src/ui/pages.ts'
import type { Page, TextBox } from '../src/ui/pages.ts'

const TUE = '2026-11-24'
const measure = (s: string) => [...s].reduce((w, ch) => w + (ch === ' ' ? 3 : 7), 0)

interface Row { id: string; title: string; due: string | null; status: string; body: string }
type Json = Record<string, any>

function fakeNotion(rows: Row[]) {
  const options = [{ id: 'a', name: 'To do' }, { id: 'b', name: 'Doing' }, { id: 'c', name: 'Done' }]
  const source = {
    object: 'data_source', id: 'ds1', title: [{ plain_text: 'Tasks' }],
    properties: {
      Name: { name: 'Name', type: 'title', title: {} },
      Due: { name: 'Due', type: 'date', date: {} },
      Status: { name: 'Status', type: 'status', status: { options, groups: [{ name: 'To-do', option_ids: ['a'] }, { name: 'In progress', option_ids: ['b'] }, { name: 'Complete', option_ids: ['c'] }] } },
    },
  }
  const requests: string[] = []
  let seq = 0

  const page = (row: Row) => ({
    object: 'page', id: row.id, url: `https://app.notion.com/p/${row.id}`,
    properties: { Name: { title: [{ plain_text: row.title }] }, Due: { date: row.due ? { start: row.due } : null }, Status: { status: { name: row.status } } },
  })

  const matches = (row: Row, filter: Json): boolean => {
    if (filter.and) return filter.and.every((part: Json) => matches(row, part))
    if (filter.status) {
      const excluded = ([] as string[]).concat(filter.status.does_not_equal)
      return !excluded.includes(row.status)
    }
    if (filter.date?.before) {
      // As documented: instants are compared, and a value without a time zone means UTC.
      const instant = (value: string) => Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value)
      return row.due !== null && instant(row.due) < instant(filter.date.before)
    }
    throw new Error(`filter not supported by the stand-in: ${JSON.stringify(filter)}`)
  }

  const answer = (status: number, body: Json) => new Response(JSON.stringify(body), { status })
  const invalid = (message: string) => answer(400, { object: 'error', code: 'validation_error', message })

  const fetcher = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const { pathname } = new URL(url)
    const body: Json = init.body ? JSON.parse(init.body) : {}
    requests.push(`${init.method} ${pathname}`)
    if (init.headers.Authorization !== 'Bearer ntn_test') return answer(401, { message: 'API token is invalid.' })
    if (init.headers['Notion-Version'] !== '2026-03-11') return invalid('Unsupported Notion-Version')

    if (init.method === 'POST' && pathname === '/v1/search') return answer(200, { results: [source] })
    if (init.method === 'GET' && pathname === '/v1/data_sources/ds1') return answer(200, source)

    if (init.method === 'POST' && pathname === '/v1/data_sources/ds1/query') {
      const found = rows.filter((row) => !body.filter || matches(row, body.filter))
      const sort = body.sorts?.[0]
      if (sort?.property === 'Due') found.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') * (sort.direction === 'descending' ? -1 : 1))
      return answer(200, { results: found.slice(0, body.page_size ?? 100).map(page) })
    }

    if (init.method === 'POST' && pathname === '/v1/pages') {
      if (body.parent?.data_source_id !== 'ds1') return invalid('Could not find data source.')
      const title = body.properties?.Name?.title?.[0]?.text?.content
      if (!title) return invalid('Name is required.')
      const row: Row = { id: `new${++seq}`, title, due: body.properties.Due?.date?.start ?? null, status: 'To do', body: (body.children ?? []).map((c: Json) => c.paragraph.rich_text[0].text.content).join('\n') }
      rows.push(row)
      return answer(200, page(row))
    }

    const one = pathname.match(/^\/v1\/pages\/([^/]+)(\/markdown)?$/)
    const row = one && rows.find((r) => r.id === one[1])
    if (one && !row) return answer(404, { object: 'error', code: 'object_not_found', message: 'Could not find page.' })
    if (row && one[2] && init.method === 'GET') return answer(200, { object: 'page_markdown', id: row.id, markdown: row.body, truncated: false })
    if (row && init.method === 'PATCH') {
      const { Status, Due } = body.properties ?? {}
      if (Status) {
        if (!options.some((o) => o.name === Status.status.name)) return invalid(`Status option "${Status.status.name}" does not exist.`)
        row.status = Status.status.name
      }
      if (Due) row.due = Due.date?.start ?? null
      return answer(200, page(row))
    }
    return answer(404, { message: 'Not found' })
  }) as unknown as typeof fetch

  return { fetcher, rows, requests }
}

async function world(t: { after: (fn: () => void) => void }, options: { relayToken?: string } = {}) {
  const notionApi = fakeNotion([
    { id: 'p1', title: 'Send the board deck to Anna', due: '2026-11-23', status: 'Doing', body: '# Board deck\n- Use the Q3 numbers\n- Keep it to 10 slides' },
    { id: 'p2', title: 'Reply to the landlord', due: '2026-11-24T09:00:00.000+01:00', status: 'To do', body: '' },
    { id: 'p3', title: 'Renew the domain', due: '2026-11-27', status: 'To do', body: '' },
    { id: 'p4', title: 'File the expenses', due: '2026-11-20', status: 'Done', body: '' },
    { id: 'p5', title: 'Someday: learn Portuguese', due: null, status: 'To do', body: '' },
    { id: 'p6', title: 'Call the dentist', due: '2026-11-25T08:30:00.000+01:00', status: 'To do', body: '' },
  ])
  const notion = new Notion({ token: 'ntn_test', fetch: notionApi.fetcher })
  const server = serve(createRelay({ notion, assistant: new Assistant(), today: () => TUE }), { token: 'relay-secret' })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const pages: Page[] = []
  const app = new App({ source: new RelaySource(base, options.relayToken ?? 'relay-secret'), measure, render: (p) => pages.push(p), exit: () => {}, later: () => {} })
  const textOf = (name: string) => (pages[pages.length - 1].boxes.find((b) => b.name === name) as TextBox | undefined)?.text ?? ''
  const choose = (action: (typeof ACTIONS)[number]) => app.input({ select: ACTIONS.indexOf(action) })
  const row = (id: string) => notionApi.rows.find((r) => r.id === id) as Row
  return { app, base, textOf, choose, row, notionApi }
}

test('glasses to Notion and back over real HTTP', async (t) => {
  const w = await world(t)
  await w.app.start()

  // Only open tasks due by today, oldest first. Done, future and undated ones stay out,
  // including one due tomorrow morning that the wider query brings back.
  assert.deepEqual(w.app.tasks.map((task) => [task.id, task.when, task.overdue]), [['p1', 'Yesterday', true], ['p2', 'Today', false]])
  assert.equal(w.app.status.list, 'Tasks')
  assert.match(w.textOf('head'), /^TODAY {3}1 of 2 +1 overdue$/)

  await w.app.input('tap')
  await w.choose('Brief me')
  assert.equal(w.textOf('body'), 'Board deck\nUse the Q3 numbers\nKeep it to 10 slides')
  await w.app.input('tap')

  await w.app.input('tap')
  await w.choose('Done')
  assert.equal(w.row('p1').status, 'Done', 'the Status moved into its Complete group')
  assert.deepEqual(w.app.tasks.map((task) => task.id), ['p2'])
  await w.app.input('tap')

  await w.app.capture('Remind me to email Sam on Friday')
  assert.equal(w.textOf('title'), 'Email Sam')
  assert.equal(w.notionApi.rows.length, 6, 'a draft writes nothing')
  await w.app.input('tap')
  assert.deepEqual(w.notionApi.rows.at(-1), { id: 'new1', title: 'Email Sam', due: '2026-11-27', status: 'To do', body: '' })
  assert.match(w.textOf('body'), /Saved to Tasks\.\nEmail Sam\nDue Fri 27 Nov/)
  await w.app.input('tap')

  await w.app.input('tap')
  await w.choose('Tomorrow')
  assert.equal(w.row('p2').due, '2026-11-25')
  assert.match(w.textOf('body'), /Moved to Tomorrow: Reply to the landlord/)

  // Nothing is due any more, so the next open tasks are offered instead of an empty screen.
  assert.deepEqual(w.app.tasks.map((task) => task.id), ['p2', 'p6', 'p3', 'new1', 'p5'])
  assert.equal(w.notionApi.requests.filter((r) => r === 'POST /v1/search').length, 1, 'the task list is discovered once')
})

test('the relay refuses strangers and reports Notion errors in plain words', async (t) => {
  const w = await world(t)
  const call = (path: string, init: RequestInit = {}) => fetch(`${w.base}${path}`, init)
  const auth = { Authorization: 'Bearer relay-secret', 'Content-Type': 'application/json' }

  assert.equal((await call('/today')).status, 401)
  assert.equal((await call('/today', { headers: { Authorization: 'Bearer nope' } })).status, 401)
  assert.equal(w.notionApi.requests.length, 0, 'nothing reaches Notion without the relay token')

  const preflight = await call('/save', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /Authorization/)

  assert.equal((await call('/nowhere', { headers: auth })).status, 404)
  const missing = await call('/done', { method: 'POST', headers: auth, body: JSON.stringify({ id: 'gone' }) })
  assert.deepEqual([missing.status, await missing.json()], [400, { error: 'Notion: Could not find page.' }])
  const broken = await call('/draft', { method: 'POST', headers: auth, body: '{not json' })
  assert.equal(broken.status, 400)
})

test('a wrong relay token shows on the glasses instead of a blank screen', async (t) => {
  const w = await world(t, { relayToken: 'typo' })
  await w.app.start()
  assert.equal(w.textOf('title'), 'All clear for today.')
  assert.match(w.textOf('note'), /Wrong or missing relay token/)
})
