// Pure text helpers shared by the relay and the app's offline demo mode:
// rule-based task drafts, verification of model drafts, plain-text briefs.

import { extractDue, isIsoDate } from './dates.mjs'

const tidy = (text) => {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().replace(/^(remind me to|i need to|i have to|i should|don't forget to|remember to|note to self[:,]?|todo[:,]?|to do[:,]?|add a task to|new task[:,]?|task[:,]?)\s+/i, '').replace(/[.\s]+$/, '')
  return clean.charAt(0).toUpperCase() + clean.slice(1)
}

/** Draft made without a model: the sentence minus its date phrase. */
export function draftByRules(spoken, today) {
  const { due, rest } = extractDue(spoken, today)
  return { title: tidy(rest).slice(0, 120), due, note: '', by: 'rules' }
}

/**
 * Accept the model's draft only as far as it can be verified:
 * the title must be non-empty and not absurdly long, the date must be a real
 * calendar date that is not in the past. Anything else falls back to the rules.
 */
export function checkDraft(candidate, spoken, today) {
  const fallback = draftByRules(spoken, today)
  if (!candidate || typeof candidate !== 'object') return fallback
  const title = tidy(candidate.title).slice(0, 120)
  if (!title) return fallback
  const due = isIsoDate(candidate.due) && candidate.due >= today ? candidate.due : candidate.due == null ? null : fallback.due
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
