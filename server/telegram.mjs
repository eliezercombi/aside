// Telegram as a second way in. Send or forward a message to your own bot and it
// becomes a task draft: it appears on your glasses, and under the message in
// Telegram, with the same two choices. A question is answered in the chat.
//
// The bot serves one private chat: the one that started it with the pairing
// code the relay prints. Everyone else gets no access and no information.
// Long polling, Node built-ins only.

import { isQuestion } from '../shared/text.mjs'

/** Minimal Bot API client. */
export class Telegram {
  constructor({ token, fetch: fetcher = fetch, api = 'https://api.telegram.org' }) {
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required')
    this.token = token
    this.fetcher = fetcher
    this.api = api
  }

  async call(method, params = {}, { signal } = {}) {
    const response = await this.fetcher(`${this.api}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    })
    const payload = await response.json().catch(() => ({}))
    if (!payload.ok) throw new Error(`Telegram: ${payload.description ?? `answered ${response.status}`}`)
    return payload.result
  }
}

const HELP = 'Send or forward me a message and it becomes a task draft on your glasses. Ask a question, such as "what is due this week?", and I answer here.'
const PRIVATE = 'This bot is private. Start it with the pairing code that the relay printed.'
const MAX_TRIES = 5

/** Who a forwarded message came from, for the note on the task. */
function origin(message) {
  const from = message.forward_origin
  if (!from) return ''
  if (from.type === 'user') return [from.sender_user?.first_name, from.sender_user?.last_name].filter(Boolean).join(' ')
  if (from.type === 'hidden_user') return from.sender_user_name ?? ''
  return from.sender_chat?.title ?? from.chat?.title ?? ''
}

export class Inbox {
  /**
   * @param {{ bot: Telegram, code: string, chatId?: number | null, log?: (line: string) => void }} options
   * `code` pairs the first chat that sends `/start <code>`; `chatId` skips pairing.
   */
  constructor({ bot, code, chatId = null, log = () => {} }) {
    this.bot = bot
    this.code = String(code)
    /** The one chat that is served, or null until it pairs. */
    this.chat = chatId
    this.log = log
    /** Drafts waiting for a decision: { id, draft, chat, message }. */
    this.items = []
    this.waiters = []
    this.tries = 0
    this.seq = 0
    this.hooks = null
  }

  /** The relay supplies what the inbox cannot do itself: drafting, saving to Notion, answering. */
  attach(hooks) {
    this.hooks = hooks
  }

  /** Drafts waiting for a decision, oldest first, in the shape the glasses app shows. */
  pending() {
    return this.items.map((item) => ({ ...item.draft, inboxId: item.id, from: 'Telegram' }))
  }

  /** Resolves when a draft arrives or is decided, or after `ms`. */
  wait(ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.waiters = this.waiters.filter((w) => w !== done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.waiters.push(done)
    })
  }

  changed() {
    for (const wake of [...this.waiters]) wake()
  }

  say(chat, text, extra = {}) {
    return this.bot.call('sendMessage', { chat_id: chat, text, ...extra })
  }

  /** One update from Telegram. */
  async handle(update) {
    if (update.callback_query) return this.pressed(update.callback_query)
    const message = update.message
    if (!message || message.chat?.type !== 'private') return
    const chat = message.chat.id
    const text = String(message.text ?? message.caption ?? '').trim()

    if (this.chat === null) {
      const given = text.match(/^\/start\s+(\S+)$/)?.[1]
      if (given && this.tries < MAX_TRIES && given === this.code) {
        this.chat = chat
        this.log(`Telegram paired with chat ${chat}. Set TELEGRAM_CHAT_ID=${chat} to keep it across restarts.`)
        return this.say(chat, `Paired. ${HELP}`)
      }
      // A wrong guess counts; after a few, pairing stays closed until the relay restarts.
      if (given) this.tries += 1
      return this.say(chat, PRIVATE)
    }
    if (chat !== this.chat) return // not the owner: no reply, no information
    if (text.startsWith('/')) return this.say(chat, HELP)
    if (!text) return this.say(chat, 'I can only read text. Send or forward a message with words in it.')

    const forwarded = Boolean(message.forward_origin ?? message.forward_date)
    if (!forwarded && isQuestion(text)) return this.say(chat, (await this.hooks.answer(text)).text)

    const draft = await this.hooks.draft(text.slice(0, 600), { received: forwarded })
    if (forwarded && !draft.note) {
      const who = origin(message)
      draft.note = `Forwarded${who ? ` from ${who}` : ''}: ${text}`.slice(0, 500)
    }
    const item = { id: String(++this.seq), draft, chat, message: null }
    const sent = await this.say(chat, `Draft: ${draft.title}\nDue: ${draft.due ? draft.when : 'no date'}\n\nIt is on your glasses now. Tap there, or choose here.`, {
      reply_markup: { inline_keyboard: [[{ text: 'Save to Notion', callback_data: `save:${item.id}` }, { text: 'Discard', callback_data: `drop:${item.id}` }]] },
    })
    item.message = sent?.message_id ?? null
    this.items.push(item)
    this.changed()
  }

  /** A button under a draft was pressed in Telegram. */
  async pressed(query) {
    const answer = (text) => this.bot.call('answerCallbackQuery', { callback_query_id: query.id, text }).catch(() => {})
    if (this.chat === null || query.message?.chat?.id !== this.chat) return answer('Not available')
    const [action, id] = String(query.data ?? '').split(':')
    try {
      await this.resolve(id, action === 'save' ? 'save' : 'drop', 'telegram')
      return answer(action === 'save' ? 'Saved' : 'Discarded')
    } catch (error) {
      return answer(error.message.slice(0, 180))
    }
  }

  /**
   * Save or discard a pending draft, from either side. The Telegram message is
   * rewritten to say what happened. If Notion refuses, the draft stays pending.
   */
  async resolve(id, action, via) {
    const at = this.items.findIndex((item) => item.id === id)
    if (at < 0) throw new Error('That draft was already handled')
    const [item] = this.items.splice(at, 1)
    let task = null
    let text = `Discarded${via === 'glasses' ? ' on your glasses' : ''}: ${item.draft.title}`
    if (action === 'save') {
      try {
        task = await this.hooks.save(item.draft)
      } catch (error) {
        this.items.splice(at, 0, item)
        throw error
      }
      text = `Saved${via === 'glasses' ? ' from your glasses' : ''}: ${task.title}${task.due ? ` (${task.when})` : ''}`
    }
    this.changed()
    if (item.message !== null) {
      // Losing this edit must not undo or fail the decision itself.
      await this.bot.call('editMessageText', { chat_id: item.chat, message_id: item.message, text }).catch((error) => this.log(error.message))
    }
    return task
  }

  /** Long-poll Telegram until `signal` aborts. */
  async run(signal) {
    let offset = 0
    while (!signal?.aborted) {
      try {
        const updates = await this.bot.call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, { signal })
        for (const update of updates ?? []) {
          offset = update.update_id + 1
          await this.handle(update).catch((error) => this.log(`Telegram update failed: ${error.message}`))
        }
      } catch (error) {
        if (signal?.aborted) return
        this.log(error.message)
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
    }
  }
}
