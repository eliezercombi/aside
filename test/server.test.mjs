import { test } from 'node:test'
import assert from 'node:assert/strict'

import { addDays, extractDue, friendly, isIsoDate } from '../shared/dates.mjs'
import { Assistant, briefByRules, checkDraft, draftByRules, parseJson } from '../server/llm.mjs'
import { NOTION_VERSION, Notion, mapSchema, openFilter, toTask } from '../server/notion.mjs'
import { createRelay, todayIn } from '../server/relay.mjs'

const TUE = '2026-11-24' // a Tuesday

test('due dates are found in ordinary sentences', () => {
  const due = (text) => extractDue(text, TUE).due
  assert.equal(due('call the bank tomorrow'), '2026-11-25')
  assert.equal(due('finish the report today'), TUE)
  assert.equal(due('send the deck to Anna on Friday'), '2026-11-27')
  assert.equal(due('standup notes by fri'), '2026-11-27')
  assert.equal(due('book flights on Tuesday'), '2026-12-01', 'a weekday named today means the next one')
  assert.equal(due('review contract next Friday'), '2026-12-04', 'next Friday is in the next calendar week')
  assert.equal(due('plan offsite next week'), '2026-11-30')
  assert.equal(due('ship it by the end of the week'), '2026-11-27')
  assert.equal(due('renew passport in 2 weeks'), '2026-12-08')
  assert.equal(due('follow up in three days'), '2026-11-27')
  assert.equal(due('pay rent 1 Dec'), '2026-12-01')
  assert.equal(due('taxes due March 3rd'), '2027-03-03', 'a date already past this year rolls to the next')
  assert.equal(due('dentist on the 27th of November'), '2026-11-27')
  assert.equal(due('invoice 2026-12-15'), '2026-12-15')
  assert.equal(due('the day after tomorrow, water plants'), '2026-11-26')
  assert.equal(due('buy milk'), null)
  assert.equal(due('I sat in the sun and may call mum'), null, 'ordinary words are not dates')
  assert.equal(due('meet on 31 November'), null, 'impossible dates are ignored')
})

test('the date phrase is removed from the task text', () => {
  assert.deepEqual(extractDue('Send the deck to Anna on Friday', TUE), { due: '2026-11-27', rest: 'Send the deck to Anna' })
  assert.deepEqual(extractDue('Tomorrow call the bank.', TUE), { due: '2026-11-25', rest: 'call the bank.' })
  assert.deepEqual(extractDue('Renew passport in 2 weeks', TUE).rest, 'Renew passport')
})

test('dates are validated and shown in a friendly way', () => {
  assert.equal(isIsoDate('2026-02-29'), false)
  assert.equal(isIsoDate('2028-02-29'), true)
  assert.equal(isIsoDate('27/11/2026'), false)
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(friendly(TUE, TUE), 'Today')
  assert.equal(friendly('2026-11-25', TUE), 'Tomorrow')
  assert.equal(friendly('2026-11-23', TUE), 'Yesterday')
  assert.equal(friendly('2026-11-27', TUE), 'Fri 27 Nov')
  assert.equal(friendly(null, TUE), 'No date')
  assert.equal(todayIn(60, Date.UTC(2026, 10, 24, 23, 30)), '2026-11-25', 'the user\'s time zone decides what today is')
})

const statusSource = {
  id: 'ds1',
  title: [{ plain_text: 'Tasks' }],
  properties: {
    Name: { name: 'Name', type: 'title', title: {} },
    Created: { name: 'Created', type: 'date', date: {} },
    'Due date': { name: 'Due date', type: 'date', date: {} },
    Status: {
      name: 'Status', type: 'status',
      status: {
        options: [{ id: 'a', name: 'Not started' }, { id: 'b', name: 'Doing' }, { id: 'c', name: 'Shipped' }, { id: 'd', name: 'Archived' }],
        groups: [{ name: 'To-do', option_ids: ['a'] }, { name: 'In progress', option_ids: ['b'] }, { name: 'Complete', option_ids: ['c', 'd'] }],
      },
    },
  },
}
const checkboxSource = { id: 'ds2', title: [], properties: { Task: { name: 'Task', type: 'title' }, Done: { name: 'Done', type: 'checkbox' } } }

test('any reasonable task database is understood from its schema', () => {
  assert.deepEqual(mapSchema(statusSource), {
    id: 'ds1', name: 'Tasks', title: 'Name', due: 'Due date',
    done: { kind: 'status', name: 'Status', set: 'Shipped', closed: ['Shipped', 'Archived'] },
  })
  assert.deepEqual(mapSchema(checkboxSource), { id: 'ds2', name: 'Tasks', title: 'Task', due: null, done: { kind: 'checkbox', name: 'Done' } })
  assert.throws(() => mapSchema({ id: 'x', properties: { Name: { name: 'Name', type: 'title' } } }), /no Status or checkbox/)
  assert.throws(() => mapSchema({ id: 'x', properties: {} }), /no title/)

  const plainStatus = { id: 'ds3', properties: { Name: { name: 'Name', type: 'title' }, State: { name: 'State', type: 'status', status: { options: [{ id: '1', name: 'Open' }, { id: '2', name: 'Done' }], groups: [] } } } }
  assert.equal(mapSchema(plainStatus).done.set, 'Done', 'falls back to an option called Done')
})

test('open-task filters follow the schema', () => {
  const status = mapSchema(statusSource)
  assert.deepEqual(openFilter(status, { before: '2026-11-26' }), {
    and: [
      { property: 'Status', status: { does_not_equal: ['Shipped', 'Archived'] } },
      { property: 'Due date', date: { before: '2026-11-26' } },
    ],
  })
  assert.deepEqual(openFilter(status), { property: 'Status', status: { does_not_equal: ['Shipped', 'Archived'] } })
  assert.deepEqual(openFilter(mapSchema(checkboxSource), { before: '2026-11-26' }), { property: 'Done', checkbox: { equals: false } }, 'no date property, no date filter')
})

test('pages become tasks', () => {
  const page = { id: 'p1', url: 'https://app.notion.com/p/p1', properties: { Name: { title: [{ plain_text: 'Send ' }, { plain_text: 'deck' }] }, 'Due date': { date: { start: '2026-11-27T09:00:00.000+01:00' } } } }
  assert.deepEqual(toTask(page, mapSchema(statusSource)), { id: 'p1', title: 'Send deck', due: '2026-11-27', url: 'https://app.notion.com/p/p1' })
  assert.equal(toTask({ id: 'p2', properties: {} }, mapSchema(statusSource)).title, 'Untitled')
})

function fakeNotion(handler) {
  const calls = []
  const fetcher = async (url, init) => {
    const call = { method: init.method, path: new URL(url).pathname + new URL(url).search, headers: init.headers, body: init.body ? JSON.parse(init.body) : null }
    calls.push(call)
    const [status, payload] = handler(call)
    return new Response(JSON.stringify(payload), { status })
  }
  return { notion: new Notion({ token: 'ntn_test', fetch: fetcher }), calls }
}

test('the Notion client sends versioned, authorised requests in the right shape', async () => {
  const { notion, calls } = fakeNotion((call) => {
    if (call.path === '/v1/data_sources/ds1') return [200, statusSource]
    if (call.path === '/v1/data_sources/ds1/query') {
      const dated = JSON.stringify(call.body.filter).includes('before')
      return [200, { results: dated ? [] : [{ id: 'p9', properties: { Name: { title: [{ plain_text: 'Someday' }] } } }] }]
    }
    if (call.path === '/v1/pages' && call.method === 'POST') return [200, { id: 'new', properties: call.body.properties }]
    if (call.path.startsWith('/v1/pages/p1/markdown')) return [200, { object: 'page_markdown', markdown: '# Notes\nBring the Q3 numbers' }]
    return [200, {}]
  })

  const tasks = await notion.today('ds1', TUE)
  assert.deepEqual(tasks.map((t) => t.title), ['Someday'], 'nothing due, so it falls back to what is next')
  assert.equal(calls.filter((c) => c.path === '/v1/data_sources/ds1').length, 1, 'the schema is fetched once')
  assert.equal(calls[1].headers['Notion-Version'], NOTION_VERSION)
  assert.equal(calls[1].headers.Authorization, 'Bearer ntn_test')
  assert.deepEqual(calls[1].body.sorts, [{ property: 'Due date', direction: 'ascending' }])

  await notion.complete('ds1', 'p1')
  assert.deepEqual(calls.at(-1), { method: 'PATCH', path: '/v1/pages/p1', headers: calls.at(-1).headers, body: { properties: { Status: { status: { name: 'Shipped' } } } } })

  await notion.reschedule('ds1', 'p1', '2026-11-25')
  assert.deepEqual(calls.at(-1).body, { properties: { 'Due date': { date: { start: '2026-11-25' } } } })

  const created = await notion.create('ds1', { title: 'Send deck', due: '2026-11-27', note: 'Use the Q3 numbers' })
  const body = calls.at(-1).body
  assert.deepEqual(body.parent, { data_source_id: 'ds1' })
  assert.deepEqual(body.properties.Name, { title: [{ text: { content: 'Send deck' } }] })
  assert.deepEqual(body.properties['Due date'], { date: { start: '2026-11-27' } })
  assert.equal(body.children[0].paragraph.rich_text[0].text.content, 'Use the Q3 numbers')
  assert.equal(created.id, 'new')

  assert.equal(await notion.content('p1'), '# Notes\nBring the Q3 numbers')
  assert.equal(calls.at(-1).path, '/v1/pages/p1/markdown?markdown_version=v2')
})

test('Notion errors surface with their message, and task lists are ranked', async () => {
  const failing = fakeNotion(() => [404, { message: 'Could not find data source.' }])
  await assert.rejects(() => failing.notion.schema('nope'), /Notion: Could not find data source/)
  assert.throws(() => new Notion({ token: '' }), /NOTION_TOKEN/)

  const { notion } = fakeNotion(() => [200, { results: [
    { id: 'r', title: [{ plain_text: 'Reading list' }], properties: { Name: { name: 'Name', type: 'title' }, Read: { name: 'Read', type: 'checkbox' } } },
    { id: 'n', title: [{ plain_text: 'Meeting notes' }], properties: { Name: { name: 'Name', type: 'title' } } },
    { ...statusSource, id: 't' },
  ] }])
  assert.deepEqual((await notion.sources()).map((s) => s.id), ['t', 'r'], 'the list called Tasks wins; unusable sources are skipped')
})

test('drafts work without a model and model drafts are verified', () => {
  assert.deepEqual(draftByRules('Remind me to send the deck to Anna on Friday.', TUE), { title: 'Send the deck to Anna', due: '2026-11-27', note: '', by: 'rules' })
  assert.equal(draftByRules('i need to call the bank tomorrow', TUE).title, 'Call the bank')

  const spoken = 'remind me to send the deck to Anna on Friday, use the Q3 numbers'
  assert.deepEqual(checkDraft({ title: 'send deck to Anna', due: '2026-11-27', note: 'Use the Q3 numbers' }, spoken, TUE), { title: 'Send deck to Anna', due: '2026-11-27', note: 'Use the Q3 numbers', by: 'model' })
  assert.equal(checkDraft({ title: 'Send deck', due: '2026-11-31' }, spoken, TUE).due, '2026-11-27', 'an impossible date falls back to the parsed one')
  assert.equal(checkDraft({ title: 'Send deck', due: '2020-01-01' }, spoken, TUE).due, '2026-11-27', 'a past date is not accepted')
  assert.equal(checkDraft({ title: 'Send deck', due: null }, spoken, TUE).due, '2026-11-27', 'a date that was said is kept even if the model drops it')
  assert.equal(checkDraft({ title: 'Send deck', due: '2026-11-28' }, spoken, TUE).due, '2026-11-27', 'and it wins when the model resolves the day wrongly')
  assert.equal(checkDraft({ title: 'Buy presents', due: '2026-12-24' }, 'buy presents before Christmas', TUE).due, '2026-12-24', 'the model may supply a date the rules cannot read')
  assert.equal(checkDraft({ title: 'Buy presents', due: null }, 'buy presents before Christmas', TUE).due, null)
  assert.equal(checkDraft({ title: '   ' }, spoken, TUE).by, 'rules')
  assert.equal(checkDraft('nonsense', spoken, TUE).by, 'rules')
  assert.deepEqual(parseJson('Sure! {"title": "A", "due": null}'), { title: 'A', due: null })
  assert.equal(parseJson('no json'), null)
})

test('the assistant calls OpenRouter and degrades gracefully', async () => {
  let seen = null
  const ok = async (url, init) => {
    seen = { url, headers: init.headers, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"Send deck to Anna","due":"2026-11-27","note":""}' } }] }), { status: 200 })
  }
  const assistant = new Assistant({ key: 'sk-or-test', fetch: ok })
  const draft = await assistant.draft('remind me to send the deck to Anna on Friday', TUE)
  assert.deepEqual(draft, { title: 'Send deck to Anna', due: '2026-11-27', note: '', by: 'model' })
  assert.equal(seen.url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(seen.headers.Authorization, 'Bearer sk-or-test')
  assert.equal(seen.body.model, 'anthropic/claude-haiku-5.5')
  assert.deepEqual(seen.body.response_format, { type: 'json_object' })
  assert.match(seen.body.messages[0].content, /Today is Tuesday, 2026-11-24/)

  const down = new Assistant({ key: 'k', fetch: async () => new Response(JSON.stringify({ error: { message: 'Rate limited' } }), { status: 429 }) })
  const fallback = await down.draft('call the bank tomorrow', TUE)
  assert.equal(fallback.by, 'rules')
  assert.equal(fallback.due, '2026-11-25')
  assert.match(fallback.warning, /Rate limited/)

  const none = new Assistant()
  assert.equal(none.enabled, false)
  assert.equal((await none.draft('buy milk', TUE)).title, 'Buy milk')
})

test('briefs are short, plain and never invented when the page is empty', async () => {
  const markdown = '# Board deck\n\n- [ ] Use the **Q3 numbers**\n- Keep it to [10 slides](https://x.y)\n\n> Anna presents on Friday'
  assert.equal(briefByRules(markdown), 'Board deck\nUse the Q3 numbers\nKeep it to 10 slides\nAnna presents on Friday')
  assert.ok(briefByRules('word '.repeat(400), 100).length <= 100)

  const assistant = new Assistant({ key: 'k', fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: '- Send the deck by Friday\n- Use Q3 numbers\n\n3. Ten slides max\nextra\nmore' } }] }), { status: 200 }) })
  assert.deepEqual(await assistant.brief('Board deck', markdown), { text: 'Send the deck by Friday\nUse Q3 numbers\nTen slides max\nextra', by: 'model' })
  assert.deepEqual(await assistant.brief('Empty', '   '), { text: 'This page is empty.', by: 'rules' })
  assert.equal((await new Assistant().brief('Board deck', markdown)).by, 'rules')
})

test('the relay ties it together and never writes on a draft', async () => {
  const log = []
  const notion = {
    sources: async () => [{ id: 'ds1', name: 'Tasks' }],
    schema: async () => ({ name: 'Tasks', due: 'Due date' }),
    today: async (id, today) => { log.push(['today', id, today]); return [{ id: 'p1', title: 'Old task', due: '2026-11-20' }, { id: 'p2', title: 'No date', due: null }] },
    complete: async (id, page) => { log.push(['complete', id, page]) },
    reschedule: async (id, page, due) => { log.push(['reschedule', page, due]) },
    create: async (id, task) => { log.push(['create', task]); return { id: 'new', ...task } },
    content: async () => '# Notes\nBring the Q3 numbers',
  }
  const routes = createRelay({ notion, assistant: new Assistant(), today: () => TUE })

  assert.deepEqual(await routes['GET /status'](), { list: 'Tasks', due: true, model: null, voice: false, telegram: false })
  const { tasks } = await routes['GET /today']()
  assert.deepEqual(tasks.map((t) => [t.when, t.overdue]), [['Fri 20 Nov', true], ['No date', false]])
  assert.deepEqual(log[0], ['today', 'ds1', TUE], 'the task list is discovered once and reused')

  const draft = await routes['POST /draft']({ text: 'Remind me to send the deck to Anna on Friday' })
  assert.deepEqual([draft.title, draft.due, draft.when, draft.heard], ['Send the deck to Anna', '2026-11-27', 'Fri 27 Nov', 'Remind me to send the deck to Anna on Friday'])
  assert.equal(log.some(([what]) => what === 'create'), false, 'a draft is only a proposal')

  const saved = await routes['POST /save']({ title: draft.title, due: draft.due, note: '' })
  assert.equal(saved.when, 'Fri 27 Nov')
  assert.deepEqual(log.at(-1), ['create', { title: 'Send the deck to Anna', due: '2026-11-27', note: '' }])

  assert.deepEqual(await routes['POST /move']({ id: 'p1', to: 'tomorrow' }), { ok: true, due: '2026-11-25', when: 'Tomorrow' })
  assert.deepEqual(await routes['POST /move']({ id: 'p1', to: 'week' }), { ok: true, due: '2026-12-01', when: 'Tue 1 Dec' })
  await assert.rejects(() => routes['POST /move']({ id: 'p1', to: 'whenever' }), /Unknown date/)
  await routes['POST /done']({ id: 'p1' })
  assert.deepEqual(log.at(-1), ['complete', 'ds1', 'p1'])

  assert.equal((await routes['POST /brief']({ id: 'p1', title: 'Old task' })).text, 'Notes\nBring the Q3 numbers')
  await assert.rejects(() => routes['POST /draft']({ text: '  ' }), /Nothing to capture/)
  await assert.rejects(() => routes['POST /save']({ title: '' }), /needs a title/)
  await assert.rejects(() => routes['POST /transcribe']({}, Buffer.from('x')), /not configured/)
})

test('voice capture is forwarded to the speech service', async () => {
  let seen = null
  const fetcher = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ text: ' Call the bank tomorrow. ' }), { status: 200 }) }
  const routes = createRelay({ notion: {}, assistant: new Assistant(), stt: { url: 'https://stt.example/v1/audio/transcriptions', key: 'k', model: 'whisper-large-v3' }, fetch: fetcher })
  assert.deepEqual(await routes['POST /transcribe']({}, Buffer.alloc(64)), { text: 'Call the bank tomorrow.' })
  assert.equal(seen.init.headers.Authorization, 'Bearer k')
  assert.equal(seen.init.body.get('model'), 'whisper-large-v3')
  assert.equal(seen.init.body.get('file').size, 64)
})
