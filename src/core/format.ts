// Text layout for one proportional font: everything is measured in pixels.

export type Measure = (text: string) => number

/** Number of spaces that fills `gapPx` without overshooting, checked against the real run width. */
function spaces(gapPx: number, measure: Measure): number {
  const one = measure(' ') || 1
  let count = Math.max(0, Math.floor(gapPx / one))
  while (count > 0 && measure(' '.repeat(count)) > gapPx) count -= 1
  while (measure(' '.repeat(count + 1)) <= gapPx) count += 1
  return count
}

/** `left` and `right` on one line, pushed to the edges of `widthPx`. */
export function spread(left: string, right: string, widthPx: number, measure: Measure): string {
  if (!right) return left
  const pad = Math.max(2, spaces(widthPx - measure(left) - measure(right), measure) - 1)
  let line = left + ' '.repeat(pad) + right
  for (let n = pad; n > 2 && measure(line) > widthPx; n -= 1) line = left + ' '.repeat(n - 1) + right
  return line
}

/** Cut a string to a pixel budget, ending with three dots when shortened. */
export function fit(text: string, widthPx: number, measure: Measure): string {
  if (measure(text) <= widthPx) return text
  let out = text
  while (out.length > 1 && measure(`${out}...`) > widthPx) out = out.slice(0, -1)
  return `${out.trimEnd()}...`
}

/**
 * Word-wrap into at most `maxLines` lines of `widthPx`. Existing line breaks
 * are kept. When the text does not fit, the last line ends with three dots.
 */
export function wrap(text: string, widthPx: number, maxLines: number, measure: Measure): string[] {
  const all: string[] = []
  for (const paragraph of text.split('\n').map((p) => p.trim()).filter(Boolean)) {
    let line = ''
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word
      if (measure(candidate) <= widthPx) {
        line = candidate
        continue
      }
      if (line) all.push(line)
      // A single word wider than the line is cut rather than left to overflow.
      line = measure(word) <= widthPx ? word : fit(word, widthPx, measure)
    }
    if (line) all.push(line)
  }
  if (all.length <= maxLines) return all
  const kept = all.slice(0, maxLines)
  let last = kept[maxLines - 1]
  while (last.length > 1 && measure(`${last}...`) > widthPx) last = last.slice(0, -1)
  kept[maxLines - 1] = `${last.trimEnd()}...`
  return kept
}
