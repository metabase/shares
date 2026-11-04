import { describe, expect, it } from 'vitest'
import { ago } from '../src/render/page'

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
