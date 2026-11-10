const SOURCE = '기상청 날씨누리';
const LOCATION = '동탄 인근 수원 관측소';
const STATION = '119';
const DAILY_URL = 'https://www.weather.go.kr/w/weather/land/past-obs/obs-by-day.do';
const DAY_MS = 86_400_000;
const WEATHER_TIMEOUT_MS = 7_000;
const MONTH_CACHE_SIZE = 72;
const monthCache = new Map();
const seoulCalendar = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' });

function readDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1900) return null;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? parsed.getTime() : null;
}

function previousYearDate(date) {
  const prior = (Number(date.slice(0, 4)) - 1) + date.slice(4);
  return readDate(prior) === null ? null : prior;
}

function pageUrl(month, element) {
  const url = new URL(DAILY_URL);
  url.search = new URLSearchParams({ stn: STATION, yy: month.slice(0, 4), mm: month.slice(5), obs: element }).toString();
  return url;
}

function spans(cell) {
  return [...cell.matchAll(/<span\b[^>]*>([^<>]*)<\/span>/gi)]
    .map(match => match[1].replace(/&nbsp;|&#160;/gi, ' ').trim())
    .filter(Boolean);
}

function observationValue(texts, label, unit) {
  const value = texts.find(text => text.startsWith(label + ':'))?.slice(label.length + 1).trim();
  const match = value?.match(/^(-?\d+(?:\.\d+)?)\s*(℃|mm)?$/);
  return match && (match[2] ?? '') === unit ? Number(match[1]) : null;
}

// The KMA calendar has a date row followed by an observation row for each week.
function parseCalendar(html, month, element) {
  const [year, numericMonth] = month.split('-').map(Number);
  const heading = new RegExp('수원\\(유\\)\\s*/\\s*</span>\\s*' + year + '년\\s*' + numericMonth + '월');
  const table = html.match(/<table\b[^>]*class=["'][^"']*\btable-cal\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/i)?.[1];
  const body = table?.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1];
  if (!heading.test(html) || !body) throw new Error('수원 관측소 날씨 달력의 지점 또는 월을 확인하지 못했습니다.');
  const weeks = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(row => [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => spans(cell[1])));
  if (weeks.length % 2 !== 0 || weeks.some(row => row.length !== 7)) throw new Error('날씨 달력 표의 형식이 변경됐습니다.');
  const observations = new Map();
  for (let i = 0; i < weeks.length; i += 2) {
    for (let weekday = 0; weekday < 7; weekday++) {
      const day = weeks[i][weekday].find(text => /^\d{1,2}일$/.test(text));
      if (!day) continue;
      const date = month + '-' + day.slice(0, -1).padStart(2, '0');
      if (readDate(date) === null || observations.has(date)) throw new Error('날씨 달력에 잘못된 날짜가 있습니다.');
      const fields = weeks[i + 1][weekday];
      if (element === '9') {
        const condition = fields.filter(text => /^[가-힣a-zA-Z0-9 (),·./+-]{1,40}$/.test(text));
        observations.set(date, condition.length ? condition.slice(0, 8).join(', ') : null);
        continue;
      }
      const min = observationValue(fields, '최저기온', '℃');
      const max = observationValue(fields, '최고기온', '℃');
      const rain = observationValue(fields, '일강수량', 'mm');
      const cloud = observationValue(fields, '평균운량', '');
      observations.set(date, {
        min, max,
        precipitation: rain !== null && rain >= 0 ? rain : null,
        cloud: cloud !== null && cloud >= 0 && cloud <= 10 ? cloud : null,
      });
    }
  }
  const expected = new Date(Date.UTC(year, numericMonth, 0)).getUTCDate();
  if (observations.size !== expected) throw new Error('날씨 달력의 일자 수를 확인하지 못했습니다.');
  return observations;
}

async function fetchCalendar(month, element) {
  const response = await fetch(pageUrl(month, element), {
    headers: { Accept: 'text/html' },
    signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('기상청 조회 응답 ' + response.status);
  return parseCalendar(await response.text(), month, element);
}

async function readMonth(month, today) {
  const existing = monthCache.get(month);
  if (existing && existing.expires > Date.now()) return existing.promise;
  const lifetime = month === today.slice(0, 7) ? 15 * 60_000 : 6 * 60 * 60_000;
  const entry = {
    expires: Date.now() + lifetime,
    promise: Promise.allSettled([fetchCalendar(month, '1'), fetchCalendar(month, '9')]),
  };
  monthCache.delete(month);
  monthCache.set(month, entry);
  if (monthCache.size > MONTH_CACHE_SIZE) monthCache.delete(monthCache.keys().next().value);
  const result = await entry.promise;
  // Transient failures can be retried without invalidating successful months.
  if (result.some(item => item.status === 'rejected') && monthCache.get(month) === entry) monthCache.delete(month);
  return result;
}

export async function fetchWeatherComparison(start, end) {
  const from = readDate(start);
  const through = readDate(end);
  if (from === null || through === null || from > through || (through - from) / DAY_MS >= 366) {
    throw new RangeError('날씨 조회 기간은 올바른 날짜로 최대 366일까지 선택해 주세요.');
  }
  const today = seoulCalendar.format(new Date());
  const dates = [];
  for (let instant = from; instant <= through; instant += DAY_MS) {
    const date = new Date(instant).toISOString().slice(0, 10);
    dates.push({ date, priorDate: previousYearDate(date) });
  }
  const months = [...new Set(dates.flatMap(row => [row.date, row.priorDate])
    .filter(date => date && date <= today).map(date => date.slice(0, 7)))];
  const results = new Map();
  const unavailableMonths = new Set();
  // At most four requests run together, including both calendar elements.
  let nextMonth = 0;
  await Promise.all(Array.from({ length: Math.min(2, months.length) }, async () => {
    while (nextMonth < months.length) {
      const month = months[nextMonth++];
      const [weather, conditions] = await readMonth(month, today);
      if (weather.status !== 'fulfilled' || conditions.status !== 'fulfilled') unavailableMonths.add(month);
      results.set(month, {
        weather: weather.status === 'fulfilled' ? weather.value : new Map(),
        conditions: conditions.status === 'fulfilled' ? conditions.value : new Map(),
      });
    }
  }));

  const observation = date => {
    if (!date || date > today) return null;
    const month = results.get(date.slice(0, 7));
    const fields = month?.weather.get(date);
    const condition = month?.conditions.get(date) ?? null;
    if (!condition && (!fields || Object.values(fields).every(value => value === null))) return null;
    return { code: null, min: null, max: null, precipitation: null, ...fields, condition, kind: date === today ? 'provisional' : 'observation' };
  };
  const rows = dates.map(({ date, priorDate }) => ({ date, priorDate, current: observation(date), prior: observation(priorDate) }));
  const warnings = [];
  if (unavailableMonths.size) warnings.push('기상청에서 일부 월의 자료를 가져오지 못했습니다 (' + [...unavailableMonths].sort().join(', ') + ').');
  if (rows.some(row => !row.current || !row.prior)) warnings.push('관측값이 없는 날짜는 공란으로 표시했습니다.');
  if (rows.some(row => row.current?.kind === 'provisional')) warnings.push('오늘의 관측값은 하루가 끝나기 전 자료라 바뀔 수 있습니다.');
  return { source: SOURCE, sourceUrl: pageUrl(start.slice(0, 7), '1').href, location: LOCATION, rows, warnings };
}
