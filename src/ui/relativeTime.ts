const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

export const formatRelative = ({
  date,
  now,
  language,
}: {
  date: string
  now: number
  language: string
}): string | null => {
  const time = Date.parse(date)
  if (Number.isNaN(time)) return null
  const seconds = Math.round((time - now) / 1000)
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' })
  const unit = UNITS.find(([, size]) => Math.abs(seconds) >= size)
  return unit
    ? format.format(Math.round(seconds / unit[1]), unit[0])
    : format.format(0, 'second')
}
