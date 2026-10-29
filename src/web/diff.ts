// Line diff for the version pages of the web app: LCS over the lines that
// differ after the common head and tail are cut off.

export type Op = { t: ' ' | '-' | '+'; s: string }

// LCS table cells; above this the diff is refused (memory and CPU time)
const MAX_CELLS = 4_000_000

// an empty text has no lines; a final newline ends the last line
function lines(s: string) {
  const out = s.split('\n')
  if (out[out.length - 1] === '') out.pop()
  return out
}

// null: too large to diff
export function lineDiff(a: string, b: string): Op[] | null {
  const x = lines(a)
  const y = lines(b)
  let head = 0
  while (head < x.length && head < y.length && x[head] === y[head]) head++
  let tail = 0
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++
  const xs = x.slice(head, x.length - tail)
  const ys = y.slice(head, y.length - tail)
  const n = xs.length
  const m = ys.length
  if (n * m > MAX_CELLS) return null

  // lcs[i * (m + 1) + j]: LCS length of xs[i..] and ys[j..]
  const lcs = new Uint32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] = xs[i] === ys[j]
        ? lcs[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1])
    }
  }
  const ops: Op[] = x.slice(0, head).map((s) => ({ t: ' ', s }))
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && xs[i] === ys[j]) { ops.push({ t: ' ', s: xs[i] }); i++; j++ }
    else if (i < n && (j === m || lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1])) ops.push({ t: '-', s: xs[i++] })
    else ops.push({ t: '+', s: ys[j++] })
  }
  for (const s of x.slice(x.length - tail)) ops.push({ t: ' ', s })
  return ops
}

// Hunks of changed lines with `context` unchanged lines around each; a
// null entry marks skipped lines.
export function hunks(ops: Op[], context = 3): (Op | null)[] {
  const keep = new Uint8Array(ops.length)
  ops.forEach((o, k) => {
    if (o.t === ' ') return
    for (let d = Math.max(0, k - context); d <= Math.min(ops.length - 1, k + context); d++) keep[d] = 1
  })
  const out: (Op | null)[] = []
  ops.forEach((o, k) => {
    if (keep[k]) out.push(o)
    else if (out.length === 0 || out[out.length - 1] !== null) out.push(null)
  })
  if (out.length && out[out.length - 1] === null) out.pop()
  return out
}

// text of a blob, or null for binary data (a NUL byte in the first 4 KiB)
export function asText(buf: ArrayBuffer | null): string | null {
  if (!buf) return null
  if (new Uint8Array(buf, 0, Math.min(4096, buf.byteLength)).includes(0)) return null
  return new TextDecoder().decode(buf)
}
