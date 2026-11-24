import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fit, spread, wrap } from '../src/core/format.ts'
import { DemoSource, RelaySource } from '../src/core/tasks.ts'
import type { Source } from '../src/core/tasks.ts'
import { App } from '../src/ui/app.ts'
import type { Voice } from '../src/ui/app.ts'
import { payload } from '../src/ui/display.ts'
import { ACTIONS, H, MENU_CAPTURE, MENU_REFRESH, W } from '../src/ui/pages.ts'
import type { Page, TextBox } from '../src/ui/pages.ts'

const TUE = '2026-11-24'
// Rough stand-in for the firmware font: about 7px a letter, narrow spaces.
const measure = (s: string) => [...s].reduce((w, ch) => w + (ch === ' ' ? 3 : 7), 0)

function setup(options: { source?: Source; voice?: Voice } = {}) {
  const pages: Page[] = []
  const timers: (() => void)[] = []
  let exits = 0
  const source = options.source ?? new DemoSource(() => TUE)
  const app = new App({
    source, measure, voice: options.voice,
    render: (page) => pages.push(page),
    exit: () => { exits += 1 },
    later: (fn) => { timers.push(fn) },
  })
  const last = () => pages[pages.length - 1]
  const textOf = (name: string) => (last().boxes.find((b) => b.name === name) as TextBox | undefined)?.text ?? ''
  const choose = (action: (typeof ACTIONS)[number]) => app.input({ select: ACTIONS.indexOf(action) })
  return { app, source, pages, timers, last, textOf, choose, exits: () => exits }
}

function assertFits(page: Page): void {
  const texts = page.boxes.filter((b) => b.type === 'text') as TextBox[]
  const lists = page.boxes.filter((b) => b.type === 'list')
  assert.ok(texts.length + lists.length <= 8, 'at most 8 text and list boxes')
  assert.equal(lists.length + texts.filter((b) => b.capture).length, 1, 'exactly one box captures input')
  assert.equal(new Set(page.boxes.map((b) => b.id)).size, page.boxes.length)
  assert.equal(new Set(page.boxes.map((b) => b.name)).size, page.boxes.length)
  for (const box of page.boxes) {
    assert.ok(box.name.length <= 16)
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.w <= W && box.y + box.h <= H, `${box.name}: outside the canvas`)
    if (box.type === 'list') {
      assert.ok(box.items.length >= 1 && box.items.length <= 20)
      for (const item of box.items) assert.ok(item.length <= 64)
      continue
    }
    assert.ok(box.text.length > 0 && box.text.length <= 1000 && box.level >= 0 && box.level <= 4)
    if (box.capture) continue
    const lines = box.text.split('\n')
    assert.ok(lines.length * 27 <= box.h, `${box.name}: ${lines.length} lines in ${box.h}px`)
    for (const line of lines) assert.ok(measure(line) <= box.w, `${box.name}: "${line}" is wider than the box`)
  }
  for (const item of page.menu) assert.ok(item.id > 0 && Buffer.byteLength(item.label) <= 32)
  // The same page must also be a valid SDK payload.
  const sent = payload(page) as { containerTotalNum: number; textObject: { zOrderIndex: number }[]; listObject: { zOrderIndex: number }[] }
  assert.equal(sent.containerTotalNum, page.boxes.length)
  const z = [...sent.textObject, ...sent.listObject].map((c) => c.zOrderIndex)
  assert.equal(new Set(z).size, z.length)
}

test('text is wrapped, cut and spread by pixel width', () => {
  assert.deepEqual(wrap('one two three four', measure('one two') + 1, 3, measure), ['one two', 'three', 'four'])
  const cut = wrap('one two three four five six seven eight', measure('one two three'), 2, measure)
  assert.deepEqual(cut, ['one two three', 'four five...'], 'the last line makes room for the dots')
  assert.ok(cut.every((line) => measure(line) <= measure('one two three')))
  assert.deepEqual(wrap('first\n\nsecond', 400, 5, measure), ['first', 'second'])
  assert.deepEqual(wrap('', 100, 2, measure), [])
  const long = wrap('supercalifragilisticexpialidocious', 100, 1, measure)
  assert.ok(measure(long[0]) <= 100 && long[0].endsWith('...'))
  assert.equal(fit('short', 100, measure), 'short')
  const line = spread('left', 'right', 300, measure)
  assert.ok(measure(line) <= 300 && measure(line) > 285 && line.startsWith('left') && line.endsWith('right'))
  assert.equal(spread('left', '', 300, measure), 'left')
})

test('today: overdue first, swipe through, tap for actions, double-tap to exit', async () => {
  const s = setup()
  await s.app.start()
  assertFits(s.last())
  assert.match(s.textOf('head'), /^DEMO {3}1 of 4 +1 overdue$/)
  assert.equal(s.textOf('title'), 'Send the board deck to Anna')
  assert.equal(s.textOf('when'), 'Overdue   Yesterday')

  await s.app.input('down')
  assert.equal(s.textOf('title'), 'Reply to the landlord about the lease')
  assert.equal(s.textOf('when'), 'Today')
  await s.app.input('up')
  await s.app.input('up')
  assert.match(s.textOf('head'), /4 of 4/, 'swiping wraps around')

  await s.app.input('tap')
  assertFits(s.last())
  assert.deepEqual((s.last().boxes[1] as { items: string[] }).items, ['Done', 'Tomorrow', 'Next week', 'Brief me', 'Back'])
  await s.choose('Back')
  assert.equal(s.last().key, 'today')
  await s.app.input('double')
  assert.equal(s.exits(), 1)
})

test('done, move and brief act on the selected task', async () => {
  const s = setup()
  await s.app.start()
  await s.app.input('tap')
  await s.choose('Brief me')
  assert.equal(s.last().key, 'brief')
  assertFits(s.last())
  assert.match(s.textOf('tag'), /^BRIEF {3}Send the board deck to Anna$/)
  assert.equal(s.textOf('body'), 'Board deck\nUse the Q3 numbers\nKeep it to 10 slides\nAnna presents on Friday at 10:00')
  await s.app.input('tap')

  await s.app.input('tap')
  await s.choose('Done')
  assert.match(s.textOf('title'), /^Done$/)
  assert.match(s.textOf('body'), /Done: Send the board deck to Anna\n3 left for today\./)
  assertFits(s.last())
  s.timers.shift()?.()
  assert.equal(s.last().key, 'today')
  assert.equal(s.textOf('title'), 'Reply to the landlord about the lease')
  assert.match(s.textOf('head'), /1 of 3 +Demo tasks$/, 'nothing overdue any more, so the list name shows')

  await s.app.input('tap')
  await s.choose('Tomorrow')
  assert.match(s.textOf('body'), /Moved to Tomorrow: Reply to the landlord/)
  await s.app.input('tap')
  assert.equal(s.app.tasks.length, 2)
})

test('capture drafts first and saves only on a tap', async () => {
  const s = setup()
  await s.app.start()
  await s.app.capture('Remind me to call the bank on Friday.')
  assert.equal(s.last().key, 'draft')
  assertFits(s.last())
  assert.equal(s.textOf('title'), 'Call the bank')
  assert.equal(s.textOf('when'), 'Due Fri 27 Nov')
  assert.equal((await s.source.today()).length, 4, 'nothing saved yet')

  await s.app.input('double')
  assert.equal(s.last().key, 'today')
  assert.match(s.textOf('note'), /Discarded/)

  await s.app.capture('water the plants today')
  await s.app.input('tap')
  assert.match(s.textOf('body'), /Saved to Demo tasks\.\nWater the plants\nDue Today/)
  assert.equal(s.app.tasks.length, 5)
  assert.ok(s.pages.some((p) => p.key === 'working'), 'slow steps show a working screen')

  await s.app.capture('   ')
  assert.match(s.textOf('body'), /Heard nothing/)
})

test('push to talk: hold, release, draft; unavailable voice explains itself', async () => {
  const log: string[] = []
  const voice: Voice = { start: () => { log.push('start') }, stop: async () => { log.push('stop'); return 'email Sam tomorrow' }, cancel: () => { log.push('cancel') } }
  const demo = new DemoSource(() => TUE)
  const talking: Source = Object.assign(Object.create(demo), { status: async () => ({ ...(await demo.status()), voice: true }) })
  const s = setup({ source: talking, voice })
  await s.app.start()

  await s.app.input('hold')
  assert.equal(s.last().key, 'listening')
  assertFits(s.last())
  await s.app.input('release')
  assert.equal(s.last().key, 'draft')
  assert.equal(s.textOf('title'), 'Email Sam')
  assert.equal(s.textOf('when'), 'Due Tomorrow')
  await s.app.input('double')

  await s.app.input({ menu: MENU_CAPTURE })
  assert.equal(s.last().key, 'listening', 'the system menu also starts a capture')
  await s.app.input('double')
  assert.deepEqual(log, ['start', 'stop', 'start', 'cancel'])

  const silent = setup()
  await silent.app.start()
  await silent.app.input('hold')
  assert.match(silent.textOf('body'), /Voice is not set up/)
  assertFits(silent.last())
})

test('failures are shown and leave the list untouched', async () => {
  const demo = new DemoSource(() => TUE)
  const failing: Source = Object.assign(Object.create(demo), {
    done: async () => { throw new Error('Notion: rate limited') },
    draft: async () => { throw new Error('The relay is not reachable') },
  })
  const s = setup({ source: failing })
  await s.app.start()
  await s.app.input('tap')
  await s.choose('Done')
  assert.match(s.textOf('title'), /^Not done$/)
  assert.match(s.textOf('body'), /Notion: rate limited\nNothing was changed\./)
  assert.equal(s.app.tasks.length, 4)
  await s.app.input('tap')
  await s.app.capture('buy milk')
  assert.match(s.textOf('body'), /relay is not reachable/)
})

test('an empty day and a refresh', async () => {
  const s = setup()
  await s.app.start()
  for (const task of [...s.app.tasks]) await s.source.done(task.id)
  await s.app.input({ menu: MENU_REFRESH })
  assert.equal(s.last().key, 'today', 'with nothing due, the next upcoming task is offered')
  assert.equal(s.textOf('title'), 'Renew the domain')
  await s.source.done('d5')
  await s.app.input({ menu: MENU_REFRESH })
  assert.equal(s.last().key, 'clear')
  assertFits(s.last())
  assert.match(s.textOf('title'), /All clear/)
  await s.app.input('tap')
  assert.equal(s.last().key, 'clear', 'nothing to act on')
})

test('long titles and notes stay inside their boxes', async () => {
  const s = setup()
  await s.app.start()
  await s.app.capture('Prepare the quarterly business review presentation for the leadership team including regional breakdowns, churn analysis and next year hiring plan by next Friday')
  assertFits(s.last())
  assert.equal(s.textOf('title').split('\n').length, 2, 'a long title takes both lines and no more')
  await s.app.input('tap')
  assertFits(s.last())
  s.timers.shift()?.()
  assertFits(s.last())
  assert.ok(s.textOf('note').split('\n').length <= 2)
})

test('the relay client speaks the relay protocol', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (url.endsWith('/today')) return new Response(JSON.stringify({ today: TUE, tasks: [{ id: 'p1', title: 'A', due: TUE, when: 'Today', overdue: false }] }), { status: 200 })
    if (url.endsWith('/status')) return new Response(JSON.stringify({ list: 'Tasks', due: true, model: 'anthropic/claude-haiku-5.5', voice: true }), { status: 200 })
    if (url.endsWith('/move')) return new Response(JSON.stringify({ ok: true, due: '2026-11-25', when: 'Tomorrow' }), { status: 200 })
    if (url.endsWith('/transcribe')) return new Response(JSON.stringify({ text: 'buy milk' }), { status: 200 })
    if (url.endsWith('/done')) return new Response(JSON.stringify({ error: 'Notion: Could not find page.' }), { status: 400 })
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  const relay = new RelaySource('http://localhost:8788/', 'secret', fetcher)

  assert.deepEqual(await relay.status(), { list: 'Tasks', due: true, model: 'anthropic/claude-haiku-5.5', voice: true, demo: false })
  assert.equal((await relay.today())[0].title, 'A')
  assert.equal(await relay.move('p1', 'tomorrow'), 'Tomorrow')
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), { id: 'p1', to: 'tomorrow' })
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer secret')
  assert.equal(await relay.transcribe(new Uint8Array(50)), 'buy milk')
  assert.equal((calls.at(-1)!.init.headers as Record<string, string>)['Content-Type'], 'audio/wav')
  await assert.rejects(() => relay.done('p1'), /Could not find page/)

  const down = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
  await assert.rejects(() => new RelaySource('http://x', 't', down).today(), /not reachable/)
})
