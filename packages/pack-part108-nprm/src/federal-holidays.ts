/**
 * The weekdays that are Federal holidays, for counting days that exclude them. Taken from the legal public holidays
 * 5 U.S.C. 6103(a) names, each on the weekday it is observed under 6103(b): a holiday on a Saturday is observed the
 * Friday before, one on a Sunday the Monday after. That is why New Year's Day 2028 (a Saturday) is listed on
 * 2027-12-31. Inauguration Day (6103(c)) is left out: it is a holiday only in the Washington, DC area. A day off
 * declared by executive order is not a legal public holiday and is not listed. The list is trusted only from
 * `from` through `through`; a new year is a new pack version.
 */
export const federalHolidayCalendar = Object.freeze({
  source: '5 U.S.C. 6103(a) and (b): legal public holidays, on the weekday each is observed',
  from: '2025-01-01',
  through: '2027-12-31',
  dates: Object.freeze([
    '2025-01-01',
    '2025-01-20',
    '2025-02-17',
    '2025-05-26',
    '2025-06-19',
    '2025-07-04',
    '2025-09-01',
    '2025-10-13',
    '2025-11-11',
    '2025-11-27',
    '2025-12-25',
    '2026-01-01',
    '2026-01-19',
    '2026-02-16',
    '2026-05-25',
    '2026-06-19',
    '2026-07-03',
    '2026-09-07',
    '2026-10-12',
    '2026-11-11',
    '2026-11-26',
    '2026-12-25',
    '2027-01-01',
    '2027-01-18',
    '2027-02-15',
    '2027-05-31',
    '2027-06-18',
    '2027-07-05',
    '2027-09-06',
    '2027-10-11',
    '2027-11-11',
    '2027-11-25',
    '2027-12-24',
    '2027-12-31',
  ] as const),
});
