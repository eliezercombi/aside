// A relay you can start with no accounts at all: the real relay and the real
// Notion client, talking to the in-memory stand-in instead of notion.so.
// For trying the phone page and the glasses app against a relay on one machine.
//
//   node test/support/dev-relay.ts        (relay token: dev-token, port 8788)

import { Assistant } from '../../server/llm.mjs'
import { Notion } from '../../server/notion.mjs'
import { createRelay, serve } from '../../server/relay.mjs'
import { addDays, iso } from '../../shared/dates.mjs'
import { fakeNotion } from './fake-notion.ts'

const now = new Date()
const today = iso(new Date(now.getTime() - now.getTimezoneOffset() * 60_000))
const stand = fakeNotion([
  { id: 'p1', title: 'Send the board deck to Anna', due: addDays(today, -1), status: 'Doing', body: '# Board deck\n- Use the Q3 numbers\n- Keep it to 10 slides\n- Anna presents on Friday at 10:00' },
  { id: 'p2', title: 'Reply to the landlord about the lease', due: `${today}T09:00:00.000+01:00`, status: 'To do', body: 'He offered 24 months at the same rent.\nAsk for a break clause after 12 months.' },
  { id: 'p3', title: 'Book flights for the Lisbon offsite', due: today, status: 'To do', body: '' },
  { id: 'p4', title: 'Renew the domain', due: addDays(today, 3), status: 'To do', body: 'Expires on the 30th. Auto-renew is off.' },
  { id: 'p5', title: 'File the expenses', due: addDays(today, -4), status: 'Done', body: '' },
])

const port = Number(process.env.PORT ?? 8788)
const token = process.env.RELAY_TOKEN ?? 'dev-token'
const notion = new Notion({ token: 'ntn_test', fetch: stand.fetcher })
const assistant = new Assistant({ key: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL || undefined })
serve(createRelay({ notion, assistant, today: () => today }), { token }).listen(port, '127.0.0.1', () => {
  console.log(`Dev relay with an in-memory task list on http://localhost:${port} (relay token: ${token})`)
})
