// The Telegram way in: pairing, drafts with buttons, answers in the chat,
// and the same draft decided from either side.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'

import { Assistant } from '../server/llm.mjs'
import { createRelay, serve } from '../server/relay.mjs'
import { Inbox, Telegram } from '../server/telegram.mjs'
import { RelaySource } from '../src/core/tasks.ts'
import type { Draft } from '../src/core/tasks.ts'
import { App } from '../src/ui/app.ts'
import type { Page, TextBox } from '../src/ui/pages.ts'

const TUE = '2026-11-24'
const OWNER = 7001
const measure = (s: string) => [...s].reduce((w, ch) => w + (ch === ' ' ? 3 : 7), 0)
type Json = Record<string, any>

/** Stand-in for the Bot API: records every call, numbers the messages it "sends". */
function fakeBot() {
  const calls: { method: string; params: Json }[] = []
  let messageId = 100
  const fetcher = (async (url: string, init: { body: string }) => {
    const method = url.split('/').pop() as string
    const params = JSON.parse(init.body)
    calls.push({ method, params })
    const result = method === 'sendMessage' ? { message_id: ++messageId, chat: { id: params.chat_id } } : true
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 })
  }) as unknown as typeof fetch
  const bot = new Telegram({ token: '123:TEST', fetch: fetcher })
  const sent = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.params.text as string)
  return { bot, calls, sent, last: () => calls[calls.length - 1] }
}

const message = (text: string, extra: Json = {}, chat = OWNER) => ({ update_id: 1, message: { message_id: 5, chat: { id: chat, type: 'private' }, text, ...extra } })
const press = (data: string, chat = OWNER) => ({ update_id: 2, callback_query: { id: 'cb1', data, message: { message_id: 101, chat: { id: chat } } } })

/** A relay with a recording Notion stand-in and the rule-based assistant. */
function world(options: { chatId?: number | null; failSave?: boolean } = {}) {
  const tg = fakeBot()
  const created: Json[] = []
  const notion = {
    sources: async () => [{ id: 'ds1', name: 'Tasks' }],
    schema: async () => ({ name: 'Tasks', due: 'Due' }),
    today: async () => [],
    open: async () => [{ id: 'p1', title: 'Send the board deck to Anna', due: '2026-11-23' }, { id: 'p2', title: 'Reply to the landlord', due: TUE }],
    create: async (_id: string, task: Json) => {
      if (options.failSave) throw new Error('Notion: rate limited')
      created.push(task)
      return { id: `new${created.length}`, title: task.title, due: task.due, url: null }
    },
  }
  const logs: string[] = []
  const inbox = new Inbox({ bot: tg.bot, code: '482913', chatId: options.chatId === undefined ? OWNER : options.chatId, log: (line: string) => logs.push(line) })
  const routes = createRelay({ notion, assistant: new Assistant(), inbox, today: () => TUE })
  return { ...tg, inbox, routes, created, logs }
}

test('the bot serves only the chat that paired with the code', async () => {
  const w = world({ chatId: null })

  await w.inbox.handle(message('send the deck to Anna on Friday'))
  await w.inbox.handle(message('/start 000000'))
  assert.deepEqual(w.sent(), Array(2).fill('This bot is private. Start it with the pairing code that the relay printed.'))
  assert.equal(w.inbox.pending().length, 0)

  await w.inbox.handle({ update_id: 3, message: { chat: { id: -500, type: 'group' }, text: '/start 482913' } })
  assert.equal(w.sent().length, 2, 'groups are ignored altogether')

  await w.inbox.handle(message('/start 482913'))
  assert.match(w.sent()[2], /^Paired\. Send or forward me a message/)
  assert.match(w.logs[0], /TELEGRAM_CHAT_ID=7001/)

  await w.inbox.handle(message('buy milk', {}, 9999))
  await w.inbox.handle(press('save:1', 9999))
  assert.equal(w.sent().length, 3, 'a stranger gets no reply')
  assert.equal(w.inbox.pending().length, 0)
  assert.equal(w.created.length, 0)
})

test('guessing the pairing code locks pairing', async () => {
  const w = world({ chatId: null })
  for (let i = 0; i < 5; i++) await w.inbox.handle(message(`/start 11111${i}`, {}, 9999))
  await w.inbox.handle(message('/start 482913', {}, 9999))
  assert.equal(w.inbox.chat, null, 'the right code no longer works after five wrong ones')
  assert.equal(w.sent().length, 6)
})

test('a message becomes a draft with two buttons, and waits', async () => {
  const w = world()
  let woke = false
  const waiting = w.inbox.wait(5000).then(() => { woke = true })

  await w.inbox.handle(message('Remind me to send the deck to Anna on Friday'))
  await waiting
  assert.equal(woke, true, 'whoever is waiting on the inbox hears about it at once')

  assert.equal(w.last().method, 'sendMessage')
  assert.equal(w.last().params.text, 'Draft: Send the deck to Anna\nDue: Fri 27 Nov\n\nIt is on your glasses now. Tap there, or choose here.')
  assert.deepEqual(w.last().params.reply_markup.inline_keyboard, [[{ text: 'Save to Notion', callback_data: 'save:1' }, { text: 'Discard', callback_data: 'drop:1' }]])
  assert.deepEqual(w.inbox.pending().map((d: Draft) => [d.inboxId, d.from, d.title, d.due, d.when]), [['1', 'Telegram', 'Send the deck to Anna', '2026-11-27', 'Fri 27 Nov']])
  assert.equal(w.created.length, 0, 'nothing is saved yet')
})

test('a forwarded message keeps who said it, and is never treated as a question', async () => {
  const w = world()
  await w.inbox.handle(message('Can you send me the Q3 deck by Friday?', { forward_origin: { type: 'user', sender_user: { first_name: 'Anna', last_name: 'Kim' } } }))
  const [draft] = w.inbox.pending()
  assert.equal(draft.due, '2026-11-27')
  assert.equal(draft.note, 'Forwarded from Anna Kim: Can you send me the Q3 deck by Friday?')

  await w.inbox.handle({ update_id: 4, message: { chat: { id: OWNER, type: 'private' }, caption: 'Sign the lease tomorrow', photo: [{}], forward_origin: { type: 'channel', chat: { title: 'Home' } } } })
  assert.equal(w.inbox.pending()[1].note, 'Forwarded from Home: Sign the lease tomorrow')

  await w.inbox.handle({ update_id: 5, message: { chat: { id: OWNER, type: 'private' }, sticker: {} } })
  assert.match(w.sent().at(-1) as string, /only read text/)
  assert.equal(w.inbox.pending().length, 2)
})

test('a question is answered in the chat and drafts nothing', async () => {
  const w = world()
  await w.inbox.handle(message('What is due this week?'))
  assert.equal(w.sent()[0], '2 open: 1 overdue, 1 due today.\n1. Send the board deck to Anna (Yesterday)\n2. Reply to the landlord (Today)')
  await w.inbox.handle(message('/help'))
  assert.match(w.sent()[1], /^Send or forward me a message/)
  assert.equal(w.inbox.pending().length, 0)
})

test('the buttons in Telegram save or discard, once', async () => {
  const w = world()
  await w.inbox.handle(message('call the bank tomorrow'))
  await w.inbox.handle(message('buy milk'))

  await w.inbox.handle(press('save:1'))
  assert.deepEqual(w.created, [{ title: 'Call the bank', due: '2026-11-25', note: '' }])
  const edit = w.calls.find((c) => c.method === 'editMessageText')!
  assert.deepEqual(edit.params, { chat_id: OWNER, message_id: 101, text: 'Saved: Call the bank (Tomorrow)' })
  assert.deepEqual(w.last(), { method: 'answerCallbackQuery', params: { callback_query_id: 'cb1', text: 'Saved' } })

  await w.inbox.handle(press('save:1'))
  assert.equal(w.created.length, 1, 'a second press saves nothing')
  assert.equal(w.last().params.text, 'That draft was already handled')

  await w.inbox.handle(press('drop:2'))
  assert.equal(w.calls.filter((c) => c.method === 'editMessageText').at(-1)!.params.text, 'Discarded: Buy milk')
  assert.equal(w.inbox.pending().length, 0)
  assert.equal(w.created.length, 1)
})

test('when Notion refuses, the draft stays and the reason is shown', async () => {
  const w = world({ failSave: true })
  await w.inbox.handle(message('call the bank tomorrow'))
  await w.inbox.handle(press('save:1'))
  assert.equal(w.last().params.text, 'Notion: rate limited')
  assert.equal(w.inbox.pending().length, 1)
  assert.equal(w.calls.some((c) => c.method === 'editMessageText'), false)
})

test('the relay exposes the inbox and holds the request until a draft arrives', async () => {
  const w = world()
  assert.equal((await w.routes['GET /status']()).telegram, true)
  assert.deepEqual(await w.routes['GET /inbox']({}, null, new URLSearchParams()), { items: [] })

  const held = w.routes['GET /inbox']({}, null, new URLSearchParams('wait=20'))
  setTimeout(() => void w.inbox.handle(message('buy milk')), 20)
  const { items } = await held
  assert.deepEqual(items.map((d: Draft) => d.title), ['Buy milk'])

  const { task } = await w.routes['POST /inbox']({ id: '1', action: 'save' })
  assert.equal(task.title, 'Buy milk')
  assert.equal(w.calls.filter((c) => c.method === 'editMessageText').at(-1)!.params.text, 'Saved from your glasses: Buy milk')
  await assert.rejects(() => w.routes['POST /inbox']({ id: '1', action: 'save' }), /already handled/)

  const without = createRelay({ notion: {}, assistant: new Assistant() })
  assert.deepEqual(await without['GET /inbox']({}, null, new URLSearchParams('wait=20')), { items: [] })
  await assert.rejects(() => without['POST /inbox']({ id: '1', action: 'save' }), /not connected/)
})

test('polling Telegram advances the offset and survives a failure', async () => {
  const seen: Json[] = []
  const stop = new AbortController()
  let round = 0
  const fetcher = (async (url: string, init: { body: string }) => {
    const method = url.split('/').pop()
    const params = JSON.parse(init.body)
    if (method !== 'getUpdates') return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })
    seen.push(params)
    round += 1
    if (round === 1) return new Response(JSON.stringify({ ok: true, result: [{ ...message('buy milk'), update_id: 41 }, { ...message('/help'), update_id: 42 }] }), { status: 200 })
    stop.abort()
    return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })
  }) as unknown as typeof fetch
  const inbox = new Inbox({ bot: new Telegram({ token: '123:TEST', fetch: fetcher }), code: '1', chatId: OWNER })
  createRelay({ notion: {}, assistant: new Assistant(), inbox, today: () => TUE })
  await inbox.run(stop.signal)
  assert.deepEqual(seen.map((p) => p.offset), [0, 43])
  assert.deepEqual(seen[0].allowed_updates, ['message', 'callback_query'])
  assert.equal(inbox.pending().length, 1)

  await assert.rejects(() => new Telegram({ token: 'x', fetch: (async () => new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 })) as unknown as typeof fetch }).call('getMe'), /Telegram: Unauthorized/)
})

test('a forwarded message reaches the glasses, and a tap there saves it', async (t) => {
  const w = world()
  const server = serve(w.routes, { token: 'relay-secret' })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const source = new RelaySource(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'relay-secret')

  const pages: Page[] = []
  const app = new App({ source, measure, render: (page) => pages.push(page), exit: () => {}, later: () => {} })
  const textOf = (name: string) => (pages[pages.length - 1].boxes.find((b) => b.name === name) as TextBox | undefined)?.text ?? ''
  await app.start()
  assert.equal(app.status.telegram, true)

  // The glasses are waiting on the inbox when the message is forwarded.
  const waiting = source.inbox(20)
  await w.inbox.handle(message('Can you send me the Q3 deck by Friday?', { forward_origin: { type: 'hidden_user', sender_user_name: 'Anna' } }))
  app.inbox(await waiting)
  assert.equal(pages[pages.length - 1].key, 'draft')
  assert.equal(textOf('tag'), 'FROM TELEGRAM')
  assert.equal(textOf('when'), 'Due Fri 27 Nov')
  assert.match(textOf('note'), /^Forwarded from Anna: Can you send me the Q3 deck/)

  await app.input('tap')
  assert.equal(w.created.length, 1)
  assert.equal(w.created[0].due, '2026-11-27')
  assert.match(w.calls.filter((c) => c.method === 'editMessageText').at(-1)!.params.text, /^Saved from your glasses: /)
  assert.deepEqual(await source.inbox(0), [])

  // A second draft is decided in Telegram while it is on the display: the display lets go of it.
  await app.input('tap')
  await w.inbox.handle(message('buy milk'))
  app.inbox(await source.inbox(0))
  assert.equal(textOf('title'), 'Buy milk')
  await w.inbox.handle(press('drop:2'))
  app.inbox(await source.inbox(0))
  assert.equal(pages[pages.length - 1].key, 'clear')
  assert.match(textOf('note'), /Handled in Telegram/)

  // A third is discarded on the glasses.
  await w.inbox.handle(message('water the plants'))
  app.inbox(await source.inbox(0))
  await app.input('double')
  assert.equal(w.inbox.pending().length, 0)
  assert.equal(w.calls.filter((c) => c.method === 'editMessageText').at(-1)!.params.text, 'Discarded on your glasses: Water the plants')
  assert.equal(w.created.length, 1)
})

test('drafts from outside never interrupt something in progress', async () => {
  const w = world()
  const pages: Page[] = []
  const draft: Draft = { title: 'Buy milk', due: null, when: 'No date', note: '', heard: 'buy milk', by: 'rules', inboxId: '9', from: 'Telegram' }
  const source = { status: async () => ({ list: 'Tasks', model: null, voice: false, telegram: true, demo: false }), today: async () => [{ id: 'p1', title: 'A', due: TUE, when: 'Today', overdue: false }] }
  const app = new App({ source: source as never, measure, render: (page) => pages.push(page), exit: () => {}, later: () => {} })
  await app.start()

  await app.input('tap')
  app.inbox([draft])
  assert.equal(pages[pages.length - 1].key, 'actions:p1', 'the actions list stays')
  await app.input('double')
  app.inbox([draft])
  assert.equal(pages[pages.length - 1].key, 'draft')
  app.inbox([draft])
  assert.equal(pages.filter((page) => page.key === 'draft').length, 1, 'the same draft is not shown again while it is on screen')
  assert.ok(w)
})
