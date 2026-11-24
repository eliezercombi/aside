// Where tasks come from. The app talks to one interface; behind it is either
// the relay (your Notion workspace) or a built-in demo list.

import { addDays, friendly } from '../../shared/dates.mjs'
import { briefByRules, draftByRules } from '../../shared/text.mjs'

export interface Task {
  id: string
  title: string
  /** YYYY-MM-DD, or null when the task has no date. */
  due: string | null
  /** The date as shown on the glasses: "Today", "Fri 27 Nov". */
  when: string
  overdue: boolean
}

export interface Draft {
  title: string
  due: string | null
  when: string
  note: string
  /** The sentence the draft was made from. */
  heard: string
  by: 'model' | 'rules'
}

export interface Status {
  /** Name of the task list. */
  list: string
  /** Model that writes drafts and briefs, or null when the built-in rules do. */
  model: string | null
  voice: boolean
  demo: boolean
}

export interface Source {
  status(): Promise<Status>
  today(): Promise<Task[]>
  done(id: string): Promise<void>
  move(id: string, to: 'tomorrow' | 'week'): Promise<string>
  draft(text: string): Promise<Draft>
  save(draft: Pick<Draft, 'title' | 'due' | 'note'>): Promise<Task>
  brief(task: Task): Promise<string>
  transcribe(wav: Uint8Array): Promise<string>
}

export class RelaySource implements Source {
  private base: string
  private token: string
  private fetcher: typeof fetch

  constructor(base: string, token: string, fetcher: typeof fetch = fetch.bind(globalThis)) {
    this.base = base.replace(/\/+$/, '')
    this.token = token
    this.fetcher = fetcher
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, raw?: Uint8Array): Promise<T> {
    let response: Response
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': raw ? 'audio/wav' : 'application/json' },
        body: raw ? (raw as BodyInit) : body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      throw new Error('The relay is not reachable')
    }
    const payload = (await response.json().catch(() => ({}))) as { error?: string }
    if (!response.ok) throw new Error(payload.error ?? `The relay answered ${response.status}`)
    return payload as T
  }

  async status(): Promise<Status> {
    return { ...(await this.call<Omit<Status, 'demo'>>('GET', '/status')), demo: false }
  }

  async today(): Promise<Task[]> {
    return (await this.call<{ tasks: Task[] }>('GET', '/today')).tasks
  }

  async done(id: string): Promise<void> {
    await this.call('POST', '/done', { id })
  }

  async move(id: string, to: 'tomorrow' | 'week'): Promise<string> {
    return (await this.call<{ when: string }>('POST', '/move', { id, to })).when
  }

  draft(text: string): Promise<Draft> {
    return this.call('POST', '/draft', { text })
  }

  save(draft: Pick<Draft, 'title' | 'due' | 'note'>): Promise<Task> {
    return this.call('POST', '/save', draft)
  }

  async brief(task: Task): Promise<string> {
    return (await this.call<{ text: string }>('POST', '/brief', { id: task.id, title: task.title })).text
  }

  async transcribe(wav: Uint8Array): Promise<string> {
    return (await this.call<{ text: string }>('POST', '/transcribe', undefined, wav)).text
  }
}

interface DemoTask { id: string; title: string; offset: number | null; notes: string }

/**
 * A believable task list that lives in memory, so the app can be tried with no
 * account. Dates are relative to today; drafts and briefs use the same rule-based
 * code the relay falls back to when it has no model.
 */
export class DemoSource implements Source {
  private items: DemoTask[] = [
    { id: 'd1', title: 'Send the board deck to Anna', offset: -1, notes: '# Board deck\n- Use the Q3 numbers\n- Keep it to 10 slides\n- Anna presents on Friday at 10:00' },
    { id: 'd2', title: 'Reply to the landlord about the lease', offset: 0, notes: 'He offered 24 months at the same rent.\nAsk for a break clause after 12 months.\nAnswer is due this week.' },
    { id: 'd3', title: 'Book flights for the Lisbon offsite', offset: 0, notes: 'Dates: 14 to 17 January.\nBudget is 400 per person.\nSix people, two flying from Berlin.' },
    { id: 'd4', title: 'Review Tom\'s pull request', offset: 0, notes: '' },
    { id: 'd5', title: 'Renew the domain', offset: 3, notes: 'Expires on the 30th. Auto-renew is off.' },
  ]
  private seq = 10
  private today_: () => string

  constructor(today: () => string = () => new Date().toISOString().slice(0, 10)) {
    this.today_ = today
  }

  private view(item: DemoTask): Task {
    const now = this.today_()
    const due = item.offset === null ? null : addDays(now, item.offset)
    return { id: item.id, title: item.title, due, when: friendly(due, now), overdue: Boolean(due && due < now) }
  }

  private find(id: string): DemoTask {
    const item = this.items.find((i) => i.id === id)
    if (!item) throw new Error('That task is gone')
    return item
  }

  async status(): Promise<Status> {
    return { list: 'Demo tasks', model: null, voice: false, demo: true }
  }

  async today(): Promise<Task[]> {
    const due = this.items.filter((i) => i.offset !== null && i.offset <= 0).sort((a, b) => (a.offset as number) - (b.offset as number))
    const pool = due.length ? due : this.items.filter((i) => i.offset === null || i.offset > 0).slice(0, 5)
    return pool.map((i) => this.view(i))
  }

  async done(id: string): Promise<void> {
    this.find(id)
    this.items = this.items.filter((i) => i.id !== id)
  }

  async move(id: string, to: 'tomorrow' | 'week'): Promise<string> {
    const item = this.find(id)
    item.offset = to === 'tomorrow' ? 1 : 7
    return this.view(item).when
  }

  async draft(text: string): Promise<Draft> {
    const now = this.today_()
    const made = draftByRules(text, now) as { title: string; due: string | null; note: string }
    return { ...made, when: friendly(made.due, now), heard: text, by: 'rules' }
  }

  async save(draft: Pick<Draft, 'title' | 'due' | 'note'>): Promise<Task> {
    const now = this.today_()
    const offset = draft.due ? Math.round((Date.parse(`${draft.due}T00:00:00Z`) - Date.parse(`${now}T00:00:00Z`)) / 86_400_000) : null
    const item: DemoTask = { id: `d${++this.seq}`, title: draft.title, offset, notes: draft.note }
    this.items.push(item)
    return this.view(item)
  }

  async brief(task: Task): Promise<string> {
    return briefByRules(this.find(task.id).notes) || 'This page is empty.'
  }

  async transcribe(): Promise<string> {
    throw new Error('Voice needs the relay. Type the task on your phone instead.')
  }
}
