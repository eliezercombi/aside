// Finds a due date in a spoken sentence: "send the deck to Anna on Friday",
// "call the bank tomorrow", "renew passport in 2 weeks", "pay rent 1 Dec".
//
// Used on its own when no language model is configured, and as a check on the
// model's answer when one is. Dates are plain YYYY-MM-DD strings; "today" is
// passed in, so the module has no clock of its own.

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
// "sat" and "sun" are left out on purpose: as bare words they are usually not weekdays.
const DAY_ALIASES = { mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5 }
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }

const pad = (n) => String(n).padStart(2, '0')
export const iso = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
export const fromIso = (text) => new Date(`${text}T00:00:00Z`)
export const addDays = (text, days) => {
  const date = fromIso(text)
  date.setUTCDate(date.getUTCDate() + days)
  return iso(date)
}
export const isIsoDate = (text) => typeof text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(fromIso(text).getTime()) && iso(fromIso(text)) === text

const monthIndex = (word) => MONTHS.findIndex((m) => m === word || m.slice(0, 3) === word.slice(0, 3))

/** Next date on or after `today` with this day and month. */
function upcoming(today, month, day) {
  const year = fromIso(today).getUTCFullYear()
  for (const y of [year, year + 1]) {
    const candidate = `${y}-${pad(month + 1)}-${pad(day)}`
    if (isIsoDate(candidate) && candidate >= today) return candidate
  }
  return null
}

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const DAY_RE = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday|mon|tues|tue|wed|thurs|thur|thu|fri)'
const LEAD = '(?:(?:due|by|on|for|before|until|this)\\s+)?'

/** Patterns in priority order. Each returns a date for a match, or null to let later patterns try. */
const RULES = [
  [new RegExp(`\\b${LEAD}(\\d{4}-\\d{2}-\\d{2})\\b`), (m) => (isIsoDate(m[1]) ? m[1] : null)],
  [new RegExp(`\\b${LEAD}(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH_RE}\\b`), (m, today) => upcoming(today, monthIndex(m[2]), Number(m[1]))],
  [new RegExp(`\\b${LEAD}${MONTH_RE}\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b`), (m, today) => upcoming(today, monthIndex(m[1]), Number(m[2]))],
  [/\b(?:the\s+)?day after tomorrow\b/, (_, today) => addDays(today, 2)],
  [new RegExp(`\\b${LEAD}(?:tomorrow|tmrw)\\b`), (_, today) => addDays(today, 1)],
  [new RegExp(`\\b${LEAD}(?:today|tonight|this evening|this afternoon|this morning)\\b`), (_, today) => today],
  [/\bin\s+(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week|month)s?\b/, (m, today) => {
    const count = WORDS[m[1]] ?? Number(m[1])
    if (m[2] === 'month') {
      const date = fromIso(today)
      date.setUTCMonth(date.getUTCMonth() + count)
      return iso(date)
    }
    return addDays(today, count * (m[2] === 'week' ? 7 : 1))
  }],
  // "next Friday" is the Friday of the next calendar week (weeks start on Monday).
  [new RegExp(`\\b(?:on\\s+|by\\s+|due\\s+)?next\\s+${DAY_RE}\\b`), (m, today) => addDays(weekday(today, 'monday'), (dayIndex(m[1]) + 6) % 7)],
  [new RegExp(`\\b${LEAD}${DAY_RE}\\b`), (m, today) => weekday(today, m[1])],
  [/\b(?:by\s+)?(?:the\s+)?end of (?:the\s+)?week\b/, (_, today) => weekday(today, 'friday', true)],
  [/\b(?:early\s+)?next week\b/, (_, today) => weekday(today, 'monday')],
  [/\bnext month\b/, (_, today) => {
    const date = fromIso(today)
    return iso(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)))
  }],
]

/** The next such weekday strictly after today (or today itself when `inclusive`). */
const dayIndex = (name) => DAY_ALIASES[name] ?? DAYS.indexOf(name)

function weekday(today, name, inclusive = false) {
  const target = dayIndex(name)
  const from = fromIso(today).getUTCDay()
  let ahead = (target - from + 7) % 7
  if (ahead === 0 && !inclusive) ahead = 7
  return addDays(today, ahead)
}

/**
 * @param {string} text
 * @param {string} today YYYY-MM-DD
 * @returns {{ due: string | null, rest: string }} the date found and the sentence without the date phrase
 */
export function extractDue(text, today) {
  const lower = text.toLowerCase()
  for (const [pattern, resolve] of RULES) {
    const match = pattern.exec(lower)
    if (!match) continue
    const due = resolve(match, today)
    if (!due) continue
    const rest = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).replace(/\s{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim()
    return { due, rest }
  }
  return { due: null, rest: text.trim() }
}

/** "Fri 27 Nov", "Today", "Tomorrow", "Yesterday" for a card on the glasses. */
export function friendly(due, today) {
  if (!due) return 'No date'
  if (due === today) return 'Today'
  if (due === addDays(today, 1)) return 'Tomorrow'
  if (due === addDays(today, -1)) return 'Yesterday'
  const date = fromIso(due)
  const label = `${DAYS[date.getUTCDay()].slice(0, 3)} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()].slice(0, 3)}`
  return label.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}
