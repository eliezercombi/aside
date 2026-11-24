// An in-memory stand-in for the parts of the Notion API the relay uses. It applies
// filters, sorts and updates the way the documentation describes, so the real
// Notion client can be exercised without a workspace.

export interface Row { id: string; title: string; due: string | null; status: string; body: string }
export type Json = Record<string, any>

export function fakeNotion(rows: Row[]) {
  const options = [{ id: 'a', name: 'To do' }, { id: 'b', name: 'Doing' }, { id: 'c', name: 'Done' }]
  const source = {
    object: 'data_source', id: 'ds1', title: [{ plain_text: 'Tasks' }],
    properties: {
      Name: { name: 'Name', type: 'title', title: {} },
      Due: { name: 'Due', type: 'date', date: {} },
      Status: { name: 'Status', type: 'status', status: { options, groups: [{ name: 'To-do', option_ids: ['a'] }, { name: 'In progress', option_ids: ['b'] }, { name: 'Complete', option_ids: ['c'] }] } },
    },
  }
  const requests: string[] = []
  let seq = 0

  const page = (row: Row) => ({
    object: 'page', id: row.id, url: `https://app.notion.com/p/${row.id}`,
    properties: { Name: { title: [{ plain_text: row.title }] }, Due: { date: row.due ? { start: row.due } : null }, Status: { status: { name: row.status } } },
  })

  const matches = (row: Row, filter: Json): boolean => {
    if (filter.and) return filter.and.every((part: Json) => matches(row, part))
    if (filter.status) {
      const excluded = ([] as string[]).concat(filter.status.does_not_equal)
      return !excluded.includes(row.status)
    }
    if (filter.date?.before) {
      // As documented: instants are compared, and a value without a time zone means UTC.
      const instant = (value: string) => Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value)
      return row.due !== null && instant(row.due) < instant(filter.date.before)
    }
    throw new Error(`filter not supported by the stand-in: ${JSON.stringify(filter)}`)
  }

  const answer = (status: number, body: Json) => new Response(JSON.stringify(body), { status })
  const invalid = (message: string) => answer(400, { object: 'error', code: 'validation_error', message })

  const fetcher = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const { pathname } = new URL(url)
    const body: Json = init.body ? JSON.parse(init.body) : {}
    requests.push(`${init.method} ${pathname}`)
    if (init.headers.Authorization !== 'Bearer ntn_test') return answer(401, { message: 'API token is invalid.' })
    if (init.headers['Notion-Version'] !== '2026-03-11') return invalid('Unsupported Notion-Version')

    if (init.method === 'POST' && pathname === '/v1/search') return answer(200, { results: [source] })
    if (init.method === 'GET' && pathname === '/v1/data_sources/ds1') return answer(200, source)

    if (init.method === 'POST' && pathname === '/v1/data_sources/ds1/query') {
      const found = rows.filter((row) => !body.filter || matches(row, body.filter))
      const sort = body.sorts?.[0]
      if (sort?.property === 'Due') found.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') * (sort.direction === 'descending' ? -1 : 1))
      return answer(200, { results: found.slice(0, body.page_size ?? 100).map(page) })
    }

    if (init.method === 'POST' && pathname === '/v1/pages') {
      if (body.parent?.data_source_id !== 'ds1') return invalid('Could not find data source.')
      const title = body.properties?.Name?.title?.[0]?.text?.content
      if (!title) return invalid('Name is required.')
      const row: Row = { id: `new${++seq}`, title, due: body.properties.Due?.date?.start ?? null, status: 'To do', body: (body.children ?? []).map((c: Json) => c.paragraph.rich_text[0].text.content).join('\n') }
      rows.push(row)
      return answer(200, page(row))
    }

    const one = pathname.match(/^\/v1\/pages\/([^/]+)(\/markdown)?$/)
    if (!one) return answer(404, { message: 'Not found' })
    const row = rows.find((r) => r.id === one[1])
    if (!row) return answer(404, { object: 'error', code: 'object_not_found', message: 'Could not find page.' })
    if (one[2] && init.method === 'GET') return answer(200, { object: 'page_markdown', id: row.id, markdown: row.body, truncated: false })
    if (!one[2] && init.method === 'PATCH') {
      const { Status, Due } = body.properties ?? {}
      if (Status) {
        if (!options.some((o) => o.name === Status.status.name)) return invalid(`Status option "${Status.status.name}" does not exist.`)
        row.status = Status.status.name
      }
      if (Due) row.due = Due.date?.start ?? null
      return answer(200, page(row))
    }
    return answer(404, { message: 'Not found' })
  }) as unknown as typeof fetch

  return { fetcher, rows, requests }
}
