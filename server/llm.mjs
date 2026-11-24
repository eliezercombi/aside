// The two jobs a language model does here, through OpenRouter:
//   1. turn a spoken sentence into a clean task (title, due date, note);
//   2. shrink a Notion page into a few lines that fit a 576x288 display.
//
// Both have a plain fallback, so the app still works with no model configured,
// and the model's output is always checked before anything is shown or saved.

import { briefByRules, checkDraft, draftByRules, parseJson } from '../shared/text.mjs'

export { briefByRules, checkDraft, draftByRules, parseJson }

export const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions'

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export class Assistant {
  constructor({ key = '', model = 'anthropic/claude-haiku-5.5', fetch: fetcher = fetch, url = OPENROUTER } = {}) {
    Object.assign(this, { key, model, fetcher, url })
  }

  get enabled() {
    return Boolean(this.key)
  }

  async ask(system, user, { json = false, maxTokens = 300 } = {}) {
    const response = await this.fetcher(this.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', 'X-Title': 'Aside for Even G2' },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        max_tokens: maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.error?.message ? `Model: ${payload.error.message}` : `Model answered ${response.status}`)
    return String(payload.choices?.[0]?.message?.content ?? '')
  }

  /** Spoken sentence -> task draft. Never throws: a model failure degrades to the rule-based draft. */
  async draft(spoken, today) {
    if (!this.enabled) return draftByRules(spoken, today)
    const weekday = DAY_NAMES[new Date(`${today}T00:00:00Z`).getUTCDay()]
    const system = [
      'You turn one spoken sentence into a to-do item. Reply with JSON only: {"title": string, "due": "YYYY-MM-DD" or null, "note": string}.',
      'title: an imperative phrase of at most 8 words, without filler such as "remind me to" and without the date.',
      'due: only if the speaker gave a date or day; resolve it against today. Otherwise null.',
      'note: details that do not fit the title, in the speaker\'s words, or an empty string. Do not invent anything.',
      `Today is ${weekday}, ${today}.`,
    ].join('\n')
    try {
      return checkDraft(parseJson(await this.ask(system, spoken, { json: true, maxTokens: 200 })), spoken, today)
    } catch (error) {
      return { ...draftByRules(spoken, today), warning: error.message }
    }
  }

  /** Page -> at most `maxChars` characters in short lines. */
  async brief(title, markdown, maxChars = 360) {
    const fallback = briefByRules(markdown, maxChars)
    if (!this.enabled || !markdown.trim()) return { text: fallback || 'This page is empty.', by: 'rules' }
    const system = [
      `Summarise the page for someone glancing at smart glasses. At most 4 short lines, at most ${maxChars} characters in total.`,
      'Plain text, one fact per line, no Markdown, no preamble. Lead with what the reader has to do or decide.',
      'Use only what is on the page.',
    ].join('\n')
    try {
      const text = (await this.ask(system, `Title: ${title}\n\n${markdown.slice(0, 6000)}`, { maxTokens: 220 }))
        .split('\n').map((line) => line.replace(/^[-*•\d.\s]+/, '').trim()).filter(Boolean).slice(0, 4).join('\n').slice(0, maxChars)
      return text ? { text, by: 'model' } : { text: fallback, by: 'rules' }
    } catch (error) {
      return { text: fallback || 'Could not read this page.', by: 'rules', warning: error.message }
    }
  }
}
