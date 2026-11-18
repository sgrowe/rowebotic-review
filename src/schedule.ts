// Convert each candidate instant through the configured time zone so weekday
// and opening time follow its daylight-saving changes.
export function idleSchedule(value: unknown): (now: number) => number {
  const invalid = 'settings.json: polling needs a timeZone, weekday start/end (HH:MM), and positive intervalSeconds/offHoursIntervalSeconds'
  if (!value || typeof value !== 'object') throw new Error(invalid)
  const { timeZone, start, end, intervalSeconds, offHoursIntervalSeconds } = value as Record<string, unknown>
  const clock = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/
  if (typeof timeZone !== 'string' || typeof start !== 'string' || typeof end !== 'string' ||
      !clock.test(start) || !clock.test(end) || start >= end ||
      typeof intervalSeconds !== 'number' || !validInterval(intervalSeconds) ||
      typeof offHoursIntervalSeconds !== 'number' || !validInterval(offHoursIntervalSeconds)) {
    throw new Error(invalid)
  }

  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  const isOpen = (instant: number) => {
    const parts = formatter.formatToParts(instant)
    const day = parts.find(part => part.type === 'weekday')?.value
    const hour = parts.find(part => part.type === 'hour')?.value
    const minute = parts.find(part => part.type === 'minute')?.value
    const time = `${hour}:${minute}`
    return day !== 'Sat' && day !== 'Sun' && time >= start && time < end
  }
  return now => {
    if (isOpen(now)) return intervalSeconds * 1000
    const offHours = offHoursIntervalSeconds * 1000
    for (let minute = Math.floor(now / 60_000) * 60_000 + 60_000; minute < now + offHours; minute += 60_000) {
      if (isOpen(minute)) return minute - now
    }
    return offHours
  }
}

function validInterval(seconds: number): boolean {
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 3600
}
