// Межі календарної доби за київським часом, з урахуванням переходу на літній/зимовий час.
// Раніше доба завжди рахувалась як 24 години від зміщення о 12:00 — у день переходу
// (остання неділя жовтня: доба 25 год; остання неділя березня: 23 год) це відрізало годину поїздок.
function kyivOffsetSec(date) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = dtf.formatToParts(date).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - date.getTime()) / 1000;
}
// unix-час київської півночі (00:00) для дати YYYY-MM-DD
function kyivMidnight(dateStr) {
  const base = Math.floor(Date.parse(dateStr + 'T00:00:00Z') / 1000);
  for (const off of [10800, 7200]) {                                  // +03:00 (літо), +02:00 (зима)
    const t = base - off;
    if (kyivOffsetSec(new Date(t * 1000)) === off) return t;
  }
  return base - kyivOffsetSec(new Date((base - 7200) * 1000));
}
export function kyivDayRange(dateStr) {
  const next = new Date(Date.parse(dateStr + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  return { from: kyivMidnight(dateStr), to: kyivMidnight(next) };
}
