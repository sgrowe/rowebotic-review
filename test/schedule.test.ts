import assert from 'node:assert/strict'
import { test } from 'node:test'
import { idleSchedule } from '../src/schedule.ts'

const delay = idleSchedule({
  timeZone: 'Europe/London',
  start: '08:50',
  end: '18:30',
  intervalSeconds: 60,
  offHoursIntervalSeconds: 600,
})

test('uses London weekday hours and wakes at the start of the window', () => {
  for (const [instant, expected] of [
    ['2026-03-27T08:45:30Z', 270_000],
    ['2026-03-27T08:50:00Z', 60_000],
    ['2026-03-27T18:29:00Z', 60_000],
    ['2026-03-27T18:30:00Z', 600_000],
    ['2026-03-28T12:00:00Z', 600_000],
    // British Summer Time began on the Sunday.
    ['2026-03-30T07:45:00Z', 300_000],
    ['2026-03-30T07:50:00Z', 60_000],
    ['2026-03-30T17:30:00Z', 600_000],
  ] as const) {
    assert.equal(delay(Date.parse(instant)), expected, instant)
  }
})
