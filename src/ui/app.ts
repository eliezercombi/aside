// The controller: what is on the glasses and what each gesture does.
// No SDK in here. Gestures come in as plain values, pages go out through
// `deps.render`, and Notion is reached only through the `Source` interface.

import { isQuestion } from '../../shared/text.mjs'
import type { Measure } from '../core/format.ts'
import type { Draft, Source, Status, Task } from '../core/tasks.ts'
import { ACTIONS, MENU_CAPTURE, MENU_REFRESH, actionsPage, briefPage, clearPage, draftPage, listeningPage, resultPage, todayPage, workingPage } from './pages.ts'
import type { Chrome, Page } from './pages.ts'

export type Input = 'tap' | 'double' | 'up' | 'down' | 'hold' | 'release' | { select: number } | { menu: number }

/** Push-to-talk, provided by the host: start capturing on hold, return the transcript on release. */
export interface Voice {
  start: () => void
  stop: () => Promise<string>
  cancel: () => void
  /** True when transcripts come from somewhere other than the relay's speech service. */
  ready?: () => boolean
}

type Screen =
  | { kind: 'today' }
  | { kind: 'actions'; id: string }
  | { kind: 'listening' }
  | { kind: 'working'; what: string }
  | { kind: 'draft'; draft: Draft }
  | { kind: 'brief'; tag: 'BRIEF' | 'ASKED'; title: string; body: string }
  | { kind: 'result'; ok: boolean; lines: string[]; token: number }

export interface Deps {
  source: Source
  measure: Measure
  render: (page: Page) => void
  /** Show the system exit dialog. */
  exit: () => void
  voice?: Voice
  later?: (fn: () => void, ms: number) => void
}

export class App {
  tasks: Task[] = []
  status: Status = { list: 'Tasks', model: null, voice: false, telegram: false, demo: false }
  index = 0
  note = 'Hold the touchpad to capture a task.'
  screen: Screen = { kind: 'today' }
  busy = false
  private token = 0
  private deps: Deps
  private later: (fn: () => void, ms: number) => void

  constructor(deps: Deps) {
    this.deps = deps
    this.later = deps.later ?? ((fn, ms) => void setTimeout(fn, ms))
  }

  /* ---------- state ---------- */

  current(): Task | undefined {
    return this.tasks[Math.min(this.index, this.tasks.length - 1)]
  }

  private chrome(): Chrome {
    return { list: this.status.list, demo: this.status.demo }
  }

  page(): Page {
    const { measure } = this.deps
    const screen = this.screen
    switch (screen.kind) {
      case 'actions': {
        const task = this.tasks.find((t) => t.id === screen.id)
        if (task) return actionsPage(task, measure)
        break
      }
      case 'listening':
        return listeningPage()
      case 'working':
        return workingPage(screen.what)
      case 'draft':
        return draftPage(screen.draft, measure)
      case 'brief':
        return briefPage(screen.tag, screen.title, screen.body, measure)
      case 'result':
        return resultPage(screen.ok, screen.lines, measure)
      default:
        break
    }
    const task = this.current()
    if (!task) return clearPage(this.note, this.chrome(), measure)
    return todayPage(task, this.tasks.indexOf(task), this.tasks, this.note, this.chrome(), measure)
  }

  render(): void {
    this.deps.render(this.page())
  }

  /** Load the list. Keeps the same task selected when it is still there. */
  async refresh(): Promise<void> {
    const selected = this.current()?.id
    this.tasks = await this.deps.source.today()
    const at = this.tasks.findIndex((t) => t.id === selected)
    this.index = at >= 0 ? at : Math.min(this.index, Math.max(0, this.tasks.length - 1))
  }

  async start(): Promise<void> {
    try {
      this.status = await this.deps.source.status()
      await this.refresh()
    } catch (error) {
      this.note = message(error)
    }
    this.render()
  }

  /* ---------- gestures ---------- */

  async input(input: Input): Promise<void> {
    if (this.busy) return
    if (typeof input === 'object' && 'menu' in input) return this.menu(input.menu)

    const screen = this.screen
    switch (screen.kind) {
      case 'today':
        if (input === 'double') return this.deps.exit()
        if (input === 'hold') return this.listen()
        if (!this.tasks.length) break
        if (input === 'down') this.index = (this.index + 1) % this.tasks.length
        else if (input === 'up') this.index = (this.index - 1 + this.tasks.length) % this.tasks.length
        else if (input === 'tap') this.screen = { kind: 'actions', id: (this.current() as Task).id }
        break

      case 'actions':
        if (input === 'double') this.screen = { kind: 'today' }
        else if (typeof input === 'object' && 'select' in input) return this.act(screen.id, ACTIONS[input.select])
        break

      case 'listening':
        if (input === 'release') return this.heard()
        if (input === 'double') {
          this.deps.voice?.cancel()
          this.screen = { kind: 'today' }
        }
        break

      case 'draft':
        if (input === 'tap') return this.save(screen.draft)
        if (input === 'double') return this.discard(screen.draft)
        break

      case 'brief':
      case 'result':
        if (input === 'tap' || input === 'double') this.screen = { kind: 'today' }
        break

      case 'working':
        break
    }
    this.render()
  }

  private async menu(id: number): Promise<void> {
    if (id === MENU_CAPTURE) return this.listen()
    if (id === MENU_REFRESH) {
      return this.work('Refreshing...', async () => {
        await this.refresh()
        this.note = this.tasks.length ? `${this.tasks.length} open for today.` : 'Nothing due.'
        this.screen = { kind: 'today' }
      })
    }
  }

  private listen(): void {
    if (!this.deps.voice || !(this.status.voice || this.deps.voice.ready?.())) {
      return this.finish(false, ['Voice is not set up.', 'Type the task on your phone instead,', 'or add a speech service to the relay.'])
    }
    this.deps.voice.start()
    this.screen = { kind: 'listening' }
    this.render()
  }

  private async heard(): Promise<void> {
    this.busy = true
    this.screen = { kind: 'working', what: 'Transcribing...' }
    this.render()
    let text = ''
    try {
      text = await (this.deps.voice as Voice).stop()
    } catch (error) {
      this.busy = false
      return this.finish(false, [message(error), 'Nothing was saved.'])
    }
    this.busy = false
    return this.capture(text)
  }

  /**
   * A spoken or typed sentence. A question about the list is answered; anything
   * else becomes a draft, and nothing is saved until the user taps.
   */
  async capture(spoken: string): Promise<void> {
    if (this.busy) return
    const text = spoken.trim()
    if (!text) return this.finish(false, ['Heard nothing.', 'Hold, speak, then release.'])
    if (isQuestion(text)) {
      return this.work('Thinking...', async () => {
        this.screen = { kind: 'brief', tag: 'ASKED', title: text, body: await this.deps.source.ask(text) }
      })
    }
    return this.work('Drafting...', async () => {
      this.screen = { kind: 'draft', draft: await this.deps.source.draft(text) }
    })
  }

  /**
   * Drafts that arrived from outside (a Telegram message). The oldest one is shown
   * when the wearer is not in the middle of something, and withdrawn if it was
   * decided elsewhere while on screen.
   */
  inbox(items: Draft[]): void {
    if (this.busy) return
    const screen = this.screen
    if (screen.kind === 'draft' && screen.draft.inboxId && !items.some((item) => item.inboxId === screen.draft.inboxId)) {
      this.note = `Handled in ${screen.draft.from ?? 'another app'}.`
      this.screen = { kind: 'today' }
      this.render()
      return
    }
    if (screen.kind === 'today' && items.length) {
      this.screen = { kind: 'draft', draft: items[0] }
      this.render()
    }
  }

  private async discard(draft: Draft): Promise<void> {
    const { source } = this.deps
    if (draft.inboxId && source.resolve) {
      const resolve = source.resolve.bind(source)
      return this.work('Discarding...', async () => {
        await resolve(draft.inboxId as string, 'drop')
        this.note = 'Discarded.'
        this.screen = { kind: 'today' }
      })
    }
    this.note = 'Discarded.'
    this.screen = { kind: 'today' }
    this.render()
  }

  private async save(draft: Draft): Promise<void> {
    return this.work('Saving to Notion...', async () => {
      const { source } = this.deps
      const fields = { title: draft.title, due: draft.due, note: draft.note }
      // A draft from the inbox is saved where it is held, so it cannot be saved twice.
      const task = draft.inboxId && source.resolve ? await source.resolve(draft.inboxId, 'save') : await source.save(fields)
      if (!task) throw new Error('The draft could not be saved')
      await this.refresh()
      this.note = `Saved: ${task.title}${task.due ? ` (${task.when})` : ''}`
      this.finish(true, [`Saved to ${this.status.list}.`, task.title, task.due ? `Due ${task.when}` : 'No date'])
    })
  }

  private async act(id: string, action: (typeof ACTIONS)[number] | undefined): Promise<void> {
    const task = this.tasks.find((t) => t.id === id)
    if (!task || !action || action === 'Back') {
      this.screen = { kind: 'today' }
      return this.render()
    }
    const { source } = this.deps

    if (action === 'Brief me') {
      return this.work('Reading the page...', async () => {
        this.screen = { kind: 'brief', tag: 'BRIEF', title: task.title, body: await source.brief(task) }
      })
    }

    return this.work(action === 'Done' ? 'Marking done...' : 'Moving...', async () => {
      if (action === 'Done') {
        await source.done(task.id)
        this.note = `Done: ${task.title}`
      } else {
        const when = await source.move(task.id, action === 'Tomorrow' ? 'tomorrow' : 'week')
        this.note = `Moved to ${when}: ${task.title}`
      }
      await this.refresh()
      this.finish(true, [this.note, this.tasks.length ? `${this.tasks.length} left for today.` : 'All clear for today.'])
    })
  }

  /** Run a slow step behind a "working" screen. Errors end on a result screen and change nothing. */
  private async work(what: string, step: () => Promise<void>): Promise<void> {
    this.busy = true
    this.screen = { kind: 'working', what }
    this.render()
    try {
      await step()
      this.render()
    } catch (error) {
      this.finish(false, [message(error), 'Nothing was changed.'])
    } finally {
      this.busy = false
    }
  }

  private finish(ok: boolean, lines: string[]): void {
    const token = ++this.token
    this.screen = { kind: 'result', ok, lines, token }
    this.render()
    // A result is a glance: it clears itself.
    this.later(() => {
      if (this.screen.kind === 'result' && this.screen.token === token) {
        this.screen = { kind: 'today' }
        this.render()
      }
    }, ok ? 2500 : 5000)
  }
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
