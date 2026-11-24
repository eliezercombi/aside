// Pure text helpers shared by the relay and the app's offline demo mode:
// rule-based task drafts, verification of model drafts, plain-text briefs.

import { extractDue, isIsoDate } from './dates.mjs'

const tidy = (text) => {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
    .replace(/^((hey|ok|okay|please|can you|could you|would you)[,\s]+)+/i, '')
    .replace(/^(remind me to|i need to|i have to|i should|don't forget to|remember to|note to self[:,]?|todo[:,]?|to do[:,]?|add a task to|new task[:,]?|task[:,]?)\s+/i, '')
    .replace(/[.?!\s]+$/, '')
  return clean.charAt(0).toUpperCase() + clean.slice(1)
}

/** Draft made without a model: the sentence minus its date phrase. */
export function draftByRules(spoken, today) {
  const { due, rest } = extractDue(spoken, today)
  return { title: tidy(rest).slice(0, 120), due, note: '', by: 'rules' }
}

/**
 * Accept the model's draft only as far as it can be verified: the title must be
 * non-empty and not absurdly long, and the date is never taken on trust (see below).
 * Anything else falls back to the rules.
 */
export function checkDraft(candidate, spoken, today) {
  const fallback = draftByRules(spoken, today)
  if (!candidate || typeof candidate !== 'object') return fallback
  const title = tidy(candidate.title).slice(0, 120)
  if (!title) return fallback
  // A date the speaker actually said ("on Friday", "1 Dec") is resolved by the rules, which are
  // exact. The model's date is used only when the rules found none, and only if it is a real,
  // future calendar date.
  const due = fallback.due ?? (isIsoDate(candidate.due) && candidate.due >= today ? candidate.due : null)
  const note = typeof candidate.note === 'string' ? candidate.note.replace(/\s+/g, ' ').trim().slice(0, 500) : ''
  return { title, due, note, by: 'model' }
}

export function parseJson(text) {
  const raw = String(text ?? '')
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * A model's free-text reply as display lines: list markers removed, blank lines
 * dropped, cut to a number of lines and characters. A leading number that is
 * part of the sentence ("3 tasks are due") is kept.
 */
export function plainLines(text, maxLines, maxChars) {
  return String(text ?? '').split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]+|\d+[.)])\s+/, '').replace(/[*_`#]/g, '').trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join('\n')
    .slice(0, maxChars)
}

/** Whether a sentence asks about the list rather than adding to it. */
export function isQuestion(text) {
  const said = String(text ?? '').trim().toLowerCase().replace(/^(hey|ok|okay|so|and|please)[,\s]+/, '')
  if (!said) return false
  // An explicit request to add something is never a question, however it is phrased.
  if (/\b(remind me|add (a |an |the )?(task|to-?do|item|reminder)|note to self|don't forget|new task)\b/.test(said)) return false
  if (/^(what|what's|whats|which|when|how many|how much|how busy|how is|how does|do i|did i|have i|am i|is there|are there|anything|should i|where|who|tell me|summari[sz]e)\b/.test(said)) return true
  return said.endsWith('?')
}

const short = (title, max = 44) => (title.length > max ? `${title.slice(0, max - 3).trimEnd()}...` : title)

/**
 * What can be said about the open list without a model: the counts and what
 * comes first. `tasks` are open tasks with `due` and `when`, oldest first.
 */
export function answerByRules(tasks, today) {
  if (!tasks.length) return 'Nothing is open.'
  const overdue = tasks.filter((task) => task.due && task.due < today).length
  const now = tasks.filter((task) => task.due === today).length
  const parts = [overdue ? `${overdue} overdue` : '', now ? `${now} due today` : ''].filter(Boolean)
  const head = `${tasks.length} open${parts.length ? `: ${parts.join(', ')}` : ', nothing due today'}.`
  return [head, ...tasks.slice(0, 3).map((task, i) => `${i + 1}. ${short(task.title)} (${task.when})`)].join('\n')
}

/** First lines of a page, stripped of Markdown, for when no model is available. */
export function briefByRules(markdown, maxChars = 360) {
  const lines = String(markdown ?? '').split('\n')
    .map((line) => line
      .replace(/<[^>]+>/g, '')
      // Leading heading, list, quote and checkbox markers, however they are stacked.
      .replace(/^\s*(?:(?:#{1,6}|[-*+]|\d+\.|>)\s+)*(?:\[[ xX]\]\s+)?/, '')
      .replace(/[*_`~]/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .trim())
    .filter(Boolean)
  let out = ''
  for (const line of lines) {
    if ((out + line).length > maxChars) break
    out += (out ? '\n' : '') + line
  }
  return out || (lines[0] ?? '').slice(0, maxChars)
}
