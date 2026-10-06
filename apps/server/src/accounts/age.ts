/** Server-only age attestation. Dates are calendar dates in UTC, not elapsed years. */
export function checkAdult(birthdate: string, now: Date = new Date()): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(birthdate)) {
    throw new RangeError('Invalid date');
  }
  if (!Number.isFinite(now.getTime()))
    throw new RangeError('Invalid current date');
  const [year, month, day] = birthdate.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  if (year === 0) throw new RangeError('Invalid date');
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new RangeError('Invalid date');
  }
  const todayYear = now.getUTCFullYear();
  const todayMonth = now.getUTCMonth() + 1;
  const todayDay = now.getUTCDate();
  if (
    year > todayYear ||
    (year === todayYear &&
      (month > todayMonth || (month === todayMonth && day > todayDay)))
  ) {
    throw new RangeError('Future date');
  }
  const age =
    todayYear -
    year -
    (todayMonth < month || (todayMonth === month && todayDay < day) ? 1 : 0);
  return age >= 18;
}
