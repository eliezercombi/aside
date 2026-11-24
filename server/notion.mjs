// Notion as a task list, over the REST API (version 2026-03-11, data sources).
//
// People build their task databases differently, so nothing is hard-coded:
// the title, the due date and the "done" switch are found in the data source
// schema, and a task is completed the way that database expects, by checking
// a checkbox or by moving a Status to its Complete group.

export const NOTION_VERSION = '2026-03-11'

/** Decide which properties play which role. Throws with a readable reason when a data source cannot work as a task list. */
export function mapSchema(dataSource) {
  const properties = Object.values(dataSource.properties ?? {})
  const byType = (type) => properties.filter((p) => p.type === type)
  const prefer = (list, pattern) => list.find((p) => pattern.test(p.name)) ?? list[0]

  const title = byType('title')[0]
  if (!title) throw new Error('This Notion data source has no title property')

  const due = prefer(byType('date'), /due|deadline|when|date|do on/i)

  const status = prefer(byType('status'), /status|state|progress/i)
  const checkbox = prefer(byType('checkbox'), /done|complete|finished|check/i)
  let done = null
  if (status) {
    const complete = status.status.groups?.find((g) => /complete|done/i.test(g.name))
    const names = (complete?.option_ids ?? []).map((id) => status.status.options.find((o) => o.id === id)?.name).filter(Boolean)
    // Fall back to an option that is simply called Done when the group is empty or missing.
    const fallback = status.status.options.find((o) => /^(done|complete|completed|finished)$/i.test(o.name))?.name
    const closed = names.length ? names : fallback ? [fallback] : []
    if (closed.length) done = { kind: 'status', name: status.name, set: closed[0], closed }
  }
  if (!done && checkbox) done = { kind: 'checkbox', name: checkbox.name }
  if (!done) throw new Error('This data source has no Status or checkbox to mark a task done')

  return { id: dataSource.id, name: plain(dataSource.title) || 'Tasks', title: title.name, due: due?.name ?? null, done }
}

const plain = (richText) => (Array.isArray(richText) ? richText.map((part) => part.plain_text ?? part.text?.content ?? '').join('') : '')

/** A Notion page reduced to what the glasses show. */
export function toTask(page, schema) {
  const properties = page.properties ?? {}
  return {
    id: page.id,
    title: plain(properties[schema.title]?.title).trim() || 'Untitled',
    due: schema.due ? properties[schema.due]?.date?.start?.slice(0, 10) ?? null : null,
    url: page.url ?? null,
  }
}

/** Filter for tasks that are still open and due on or before `until` (or have no date when `undated`). */
export function openFilter(schema, { until = null, undated = false } = {}) {
  const open = schema.done.kind === 'checkbox'
    ? { property: schema.done.name, checkbox: { equals: false } }
    : { property: schema.done.name, status: { does_not_equal: schema.done.closed } }
  if (!schema.due || (!until && !undated)) return open
  const when = undated
    ? { property: schema.due, date: { is_empty: true } }
    : { property: schema.due, date: { on_or_before: until } }
  return { and: [open, when] }
}

export class Notion {
  constructor({ token, fetch: fetcher = fetch, version = NOTION_VERSION }) {
    if (!token) throw new Error('NOTION_TOKEN is required')
    Object.assign(this, { token, fetcher, version, schemas: new Map() })
  }

  async call(method, path, body) {
    const response = await this.fetcher(`https://api.notion.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Notion-Version': this.version, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.message ? `Notion: ${payload.message}` : `Notion answered ${response.status}`)
    return payload
  }

  /** Data sources this token can see that are usable as task lists, best match first. */
  async sources() {
    const found = await this.call('POST', '/v1/search', { filter: { property: 'object', value: 'data_source' }, page_size: 50 })
    const usable = []
    for (const source of found.results ?? []) {
      try {
        usable.push(mapSchema(source))
      } catch { /* not a task list */ }
    }
    const score = (s) => (/task|to.?do|action|inbox/i.test(s.name) ? 2 : 0) + (s.due ? 1 : 0)
    return usable.sort((a, b) => score(b) - score(a))
  }

  async schema(dataSourceId) {
    if (!this.schemas.has(dataSourceId)) this.schemas.set(dataSourceId, mapSchema(await this.call('GET', `/v1/data_sources/${dataSourceId}`)))
    return this.schemas.get(dataSourceId)
  }

  /** Open tasks due today or earlier, oldest first; when there are none, whatever comes next. */
  async today(dataSourceId, today, limit = 20) {
    const schema = await this.schema(dataSourceId)
    const query = (filter) => this.call('POST', `/v1/data_sources/${dataSourceId}/query`, {
      filter,
      page_size: limit,
      sorts: schema.due ? [{ property: schema.due, direction: 'ascending' }] : [{ timestamp: 'created_time', direction: 'descending' }],
    })
    let pages = (await query(openFilter(schema, { until: today }))).results ?? []
    if (!pages.length) pages = ((await query(openFilter(schema))).results ?? []).slice(0, 5)
    return pages.map((page) => toTask(page, schema))
  }

  async complete(dataSourceId, pageId) {
    const { done } = await this.schema(dataSourceId)
    const value = done.kind === 'checkbox' ? { checkbox: true } : { status: { name: done.set } }
    await this.call('PATCH', `/v1/pages/${pageId}`, { properties: { [done.name]: value } })
  }

  async reschedule(dataSourceId, pageId, due) {
    const schema = await this.schema(dataSourceId)
    if (!schema.due) throw new Error('This task list has no date property')
    await this.call('PATCH', `/v1/pages/${pageId}`, { properties: { [schema.due]: { date: { start: due } } } })
  }

  async create(dataSourceId, { title, due = null, note = '' }) {
    const schema = await this.schema(dataSourceId)
    const properties = { [schema.title]: { title: [{ text: { content: title.slice(0, 200) } }] } }
    if (due && schema.due) properties[schema.due] = { date: { start: due } }
    const body = { parent: { data_source_id: dataSourceId }, properties }
    if (note) body.children = [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: note.slice(0, 1900) } }] } }]
    return toTask(await this.call('POST', '/v1/pages', body), schema)
  }

  /** Page body as Markdown, for the brief. */
  async content(pageId) {
    const page = await this.call('GET', `/v1/pages/${pageId}/markdown?markdown_version=v2`)
    return String(page.markdown ?? '')
  }
}
