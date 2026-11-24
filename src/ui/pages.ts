// Pure page builders for the 576x288 display: state in, boxes out.
// One proportional font, 27px lines, five text brightness levels (0-4),
// at most 8 text/list boxes per page, exactly one of which captures input.

import { fit, spread, wrap } from '../core/format.ts'
import type { Measure } from '../core/format.ts'
import type { Draft, Task } from '../core/tasks.ts'

export const W = 576
export const H = 288
const MARGIN = 4
const INNER = W - 2 * MARGIN
const LINE = 27

export interface TextBox {
  type: 'text'
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  text: string
  /** Text brightness 0-4. */
  level: number
  capture?: boolean
}

export interface ListBox {
  type: 'list'
  id: number
  name: string
  x: number
  y: number
  w: number
  h: number
  items: string[]
}

export type Box = TextBox | ListBox

export interface Page {
  /** Pages with the same key share a layout, so only changed text is re-sent. */
  key: string
  boxes: Box[]
  menu: { id: number; label: string }[]
}

export const MENU_CAPTURE = 1
export const MENU_REFRESH = 2
const MENU = [{ id: MENU_CAPTURE, label: 'Capture a task' }, { id: MENU_REFRESH, label: 'Refresh' }]

export const ACTIONS = ['Done', 'Tomorrow', 'Next week', 'Brief me', 'Back'] as const

const text = (id: number, name: string, y: number, lines: number, content: string, level: number): TextBox => ({
  type: 'text', id, name, x: MARGIN, y, w: INNER, h: lines * LINE, text: content || ' ', level,
})

/** Invisible full-screen box that receives taps and swipes on text pages. */
const captureLayer = (): TextBox => ({ type: 'text', id: 90, name: 'input', x: 0, y: 0, w: W, h: H, text: ' ', level: 0, capture: true })

export interface Chrome {
  /** Name of the task list, e.g. "Tasks" or "Demo tasks". */
  list: string
  demo: boolean
}

export function todayPage(task: Task, index: number, tasks: Task[], note: string, chrome: Chrome, measure: Measure): Page {
  const overdue = tasks.filter((t) => t.overdue).length
  const left = `${chrome.demo ? 'DEMO' : 'TODAY'}   ${index + 1} of ${tasks.length}`
  const right = overdue ? `${overdue} overdue` : fit(chrome.list, 220, measure)
  return {
    key: 'today',
    menu: MENU,
    boxes: [
      captureLayer(),
      text(1, 'head', 0, 1, spread(left, right, INNER, measure), 2),
      text(2, 'title', 40, 2, wrap(task.title, INNER, 2, measure).join('\n'), 4),
      text(3, 'when', 104, 1, task.overdue ? `Overdue   ${task.when}` : task.when, task.overdue ? 4 : 3),
      text(4, 'note', 150, 2, wrap(note, INNER, 2, measure).join('\n'), 2),
      text(5, 'hint', 258, 1, 'tap: actions   swipe: next   hold: capture   double-tap: exit', 1),
    ],
  }
}

export function clearPage(note: string, chrome: Chrome, measure: Measure): Page {
  return {
    key: 'clear',
    menu: MENU,
    boxes: [
      captureLayer(),
      text(1, 'head', 0, 1, chrome.demo ? 'DEMO' : fit(chrome.list, INNER, measure), 2),
      text(2, 'title', 54, 1, 'All clear for today.', 4),
      text(3, 'note', 104, 2, wrap(note, INNER, 2, measure).join('\n'), 2),
      text(4, 'hint', 258, 1, 'hold: capture a task   double-tap: exit', 1),
    ],
  }
}

export function actionsPage(task: Task, measure: Measure): Page {
  return {
    key: `actions:${task.id}`,
    menu: MENU,
    boxes: [
      text(1, 'title', 0, 1, fit(task.title, INNER, measure), 2),
      { type: 'list', id: 2, name: 'actions', x: 0, y: 32, w: W, h: H - 32, items: [...ACTIONS] },
    ],
  }
}

export function listeningPage(): Page {
  return {
    key: 'listening',
    menu: MENU,
    boxes: [
      captureLayer(),
      text(1, 'title', 36, 1, 'Listening...', 4),
      text(2, 'body', 82, 3, 'Say it the way you would to a colleague:\n"send the deck to Anna on Friday"', 2),
      text(3, 'hint', 258, 1, 'release: done   double-tap: cancel', 1),
    ],
  }
}

export function workingPage(what: string): Page {
  return {
    key: 'working',
    menu: MENU,
    boxes: [captureLayer(), text(1, 'title', 108, 1, what, 3)],
  }
}

export function draftPage(draft: Draft, measure: Measure): Page {
  return {
    key: 'draft',
    menu: MENU,
    boxes: [
      captureLayer(),
      text(1, 'tag', 0, 1, 'NEW TASK', 2),
      text(2, 'title', 36, 2, wrap(draft.title, INNER, 2, measure).join('\n'), 4),
      text(3, 'when', 98, 1, draft.due ? `Due ${draft.when}` : 'No date', 3),
      text(4, 'note', 134, 2, wrap(draft.note, INNER, 2, measure).join('\n'), 2),
      text(5, 'hint', 228, 2, 'tap: save to Notion\ndouble-tap: discard', 2),
    ],
  }
}

export function briefPage(title: string, body: string, measure: Measure): Page {
  return {
    key: 'brief',
    menu: MENU,
    boxes: [
      captureLayer(),
      text(1, 'tag', 0, 1, fit(`BRIEF   ${title}`, INNER, measure), 2),
      text(2, 'body', 40, 7, wrap(body, INNER, 7, measure).join('\n'), 4),
      text(3, 'hint', 258, 1, 'tap: back', 1),
    ],
  }
}

export function resultPage(ok: boolean, lines: string[], measure: Measure): Page {
  return {
    key: 'result',
    menu: MENU,
    boxes: [
      captureLayer(),
      text(1, 'title', 36, 1, ok ? 'Done' : 'Not done', 4),
      text(2, 'body', 78, 4, wrap(lines.join('\n'), INNER, 4, measure).join('\n'), 3),
      text(3, 'hint', 258, 1, 'tap: back', 1),
    ],
  }
}
