import { describe, expect, it } from 'vitest'
import { ago } from '../src/render/page'
import { person, recency } from '../src/web/shell'

const NOW = Date.UTC(2026, 10, 4, 12, 0)
const MIN = 60_000

describe('ago', () => {
  it('gives minutes, hours and days in short form', () => {
    expect(ago(NOW - 30_000, NOW)).toBe('just now')
    expect(ago(NOW - 12 * MIN, NOW)).toBe('12m ago')
    expect(ago(NOW - 125 * MIN, NOW)).toBe('2h ago')
    expect(ago(NOW - 3 * 1440 * MIN - 5 * 60 * MIN, NOW)).toBe('3d ago')
  })

  it('gives the date from 7 days, with the year only for another year', () => {
    expect(ago(Date.UTC(2026, 9, 28, 9), NOW)).toBe('Oct 28')
    expect(ago(Date.UTC(2025, 11, 30), NOW)).toBe('Dec 30, 2025')
    expect(ago(0, NOW)).toBe('—')
  })
})

describe('recency', () => {
  it('marks times of the last 24 hours as recent', () => {
    expect(recency(NOW - 23 * 60 * MIN, NOW)).toBe('rec')
    expect(recency(NOW - 25 * 60 * MIN, NOW)).toBe('old')
  })
})

describe('person', () => {
  it('gives one hue per email, whatever its case', () => {
    const hue = (s: string) => s.match(/av h(\d)/)![1]
    expect(hue(person('sam.chen@metabase.com'))).toBe(hue(person('Sam.Chen@metabase.com', true)))
    const hues = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((n) => hue(person(`${n}@x.com`))))
    expect(hues.size).toBeGreaterThan(3)
  })

  it('shows the initial and the name before @, or the full email', () => {
    expect(person('sam.chen@metabase.com')).toMatch(/>S<\/span>sam\.chen<\/span>$/)
    expect(person('sam.chen@metabase.com', true)).toContain('>sam.chen@metabase.com</span>')
    expect(person('<b>@x.com')).toContain('&lt;b&gt;')
  })
})
