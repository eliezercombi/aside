// The phone side: a mirror of the glasses display, a box to type a task into,
// and the connection to the relay.

import type { App, Input } from './ui/app.ts'
import { H, W } from './ui/pages.ts'
import type { Page } from './ui/pages.ts'

export interface CompanionApi {
  app: App
  /** True when no glasses bridge was found and gestures come from on-screen buttons. */
  preview: boolean
  relay: () => { url: string; token: string } | null
  setRelay: (relay: { url: string; token: string } | null) => void
  capture: (text: string) => void
  input: (input: Input) => void
}

const esc = (value: unknown): string => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const LEVELS = [0.18, 0.34, 0.52, 0.76, 1]

function mirror(page: Page | null, preview: boolean): string {
  if (!page) return '<div class="lens"></div>'
  const boxes = page.boxes.map((box) => {
    const frame = `left:${(box.x / W) * 100}%;top:${(box.y / H) * 100}%;width:${(box.w / W) * 100}%;height:${(box.h / H) * 100}%`
    if (box.type === 'list') {
      const items = box.items.map((item, i) => `<button class="li" data-select="${i}" ${preview ? '' : 'disabled'}>${esc(item)}</button>`).join('')
      return `<div class="box list" style="${frame}">${items}</div>`
    }
    if (box.capture) return ''
    return `<div class="box" style="${frame};opacity:${LEVELS[box.level] ?? 1}">${esc(box.text)}</div>`
  }).join('')
  return `<div class="lens">${boxes}</div>`
}

export function mountCompanion(root: HTMLElement, api: CompanionApi): { update: (page: Page) => void } {
  let page: Page | null = null
  let scheduled = false
  let editing = false

  const render = (): void => {
    scheduled = false
    if (editing) return // do not replace inputs under the user's fingers
    const { app } = api
    const relay = api.relay()
    const { status } = app

    root.innerHTML = `
      <header>
        <h1>Aside</h1>
        <p class="status"><span class="dot ${status.demo ? 'polling' : 'live'}"></span>${status.demo ? 'demo list' : esc(status.list)}${api.preview ? ' · browser preview' : ''}</p>
      </header>

      <section>
        ${mirror(page, api.preview)}
        ${api.preview ? `<div class="pad">
          <button data-input="up">swipe up</button><button data-input="tap">tap</button>
          <button data-input="down">swipe down</button><button data-input="double">double-tap</button>
        </div><p class="fine">No glasses found, so this page stands in for them. The green panel shows what the display would show.</p>` : ''}
      </section>

      <section>
        <h2>Capture or ask</h2>
        <form data-form="capture"><input name="text" placeholder="send the deck to Anna on Friday" autocomplete="off" maxlength="300"><button>Send</button></form>
        <p class="fine">Say it on the glasses (hold the touchpad) or type it here. A task comes back as a draft on the display and is saved to Notion only when you tap. A question, such as &quot;what is due this week?&quot;, is answered on the display.</p>
      </section>

      <section>
        <h2>Today</h2>
        ${app.tasks.length ? `<ul class="rows">${app.tasks.map((task) => `<li><span>${esc(task.title)}</span><span class="when ${task.overdue ? 'late' : ''}">${esc(task.when)}</span></li>`).join('')}</ul>` : '<p class="fine">Nothing due.</p>'}
      </section>

      <section>
        <h2>Notion</h2>
        <form data-form="relay" class="fields stack">
          <label>Relay address<input name="url" inputmode="url" placeholder="http://localhost:8788" value="${esc(relay?.url ?? '')}" autocomplete="off"></label>
          <label>Relay token<input name="token" type="password" placeholder="printed when the relay starts" value="${esc(relay?.token ?? '')}" autocomplete="off"></label>
          <button>${relay ? 'Reconnect' : 'Connect my Notion'}</button>
        </form>
        ${relay ? '<div class="pad"><button data-demo>Back to the demo list</button></div>' : ''}
        <p class="fine">${status.demo
          ? 'You are looking at a built-in demo list. To use your own tasks, run the relay from this repository with a Notion token and enter its address here. The token never leaves the machine the relay runs on.'
          : `Drafts and briefs are written by ${status.model ? esc(status.model) : 'built-in rules'}. Voice is ${status.voice ? 'on' : 'off'}.`}</p>
      </section>`
  }

  const schedule = (): void => {
    if (scheduled) return
    scheduled = true
    // A timer, not requestAnimationFrame: the mirror must keep up while the page is in the background.
    setTimeout(render, 30)
  }

  root.addEventListener('focusin', (event) => { if ((event.target as HTMLElement).tagName === 'INPUT') editing = true })
  root.addEventListener('focusout', () => { editing = false; schedule() })

  root.addEventListener('click', (event) => {
    const el = (event.target as HTMLElement).closest('button') as HTMLButtonElement | null
    if (!el || el.disabled) return
    const data = el.dataset
    if (data.input) api.input(data.input as Input)
    else if (data.select) api.input({ select: Number(data.select) })
    else if ('demo' in data) api.setRelay(null)
    else return
    schedule()
  })

  root.addEventListener('submit', (event) => {
    event.preventDefault()
    const form = event.target as HTMLFormElement
    const values = new FormData(form)
    if (form.dataset.form === 'capture') {
      const text = String(values.get('text') ?? '').trim()
      if (text) api.capture(text)
    }
    if (form.dataset.form === 'relay') {
      const url = String(values.get('url') ?? '').trim()
      const token = String(values.get('token') ?? '').trim()
      if (/^https?:\/\/\S+$/.test(url) && token) api.setRelay({ url, token })
    }
    editing = false
    ;(document.activeElement as HTMLElement | null)?.blur()
    schedule()
  })

  schedule()
  return {
    update(next: Page) {
      page = next
      schedule()
    },
  }
}
