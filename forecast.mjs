const SOURCE = '기상청 날씨누리';
const LOCATION = '롯데백화점 동탄점 일대';
// KMA place search returns this code for the store at 동탄역로 160.
const AREA_CODE = '4159755000';
const SOURCE_URL = 'https://www.weather.go.kr/w/wnuri-fct2021/main/digital-forecast.do?code=' + AREA_CODE + '&hr1=Y&unit=m%2Fs';
const DAY_MS = 86_400_000;
const CACHE_MS = 10 * 60_000;
const seoulCalendar = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' });
let cached = null;
let pending = null;

function blankRow(date) {
  return { date, min: null, max: null, precipitationProbability: null, condition: null, icon: 'unknown', scope: null };
}

function forecastIcon(conditions) {
  const text = conditions.join(' ');
  if (/천둥|번개|뇌우/.test(text)) return 'thunder';
  const rain = /비|소나기|빗방울|우박/.test(text);
  const snow = /눈|적설|진눈깨비/.test(text);
  if ((rain && snow) || /진눈깨비/.test(text)) return 'mix';
  if (snow) return 'snow';
  if (rain) return 'rain';
  if (/안개|박무/.test(text)) return 'fog';
  if (/구름|흐림|흐리/.test(text)) return 'cloud';
  if (/맑음|맑고/.test(text)) return 'sun';
  return 'unknown';
}

function readTemperature(card, label) {
  const field = new RegExp('<strong>\\s*' + label + '\\s*:\\s*</strong>\\s*<span>\\s*(-?\\d+(?:\\.\\d+)?)\\s*℃\\s*</span>');
  const value = Number(card.match(field)?.[1]);
  return Number.isFinite(value) && value >= -100 && value <= 80 ? value : null;
}

function readForecast(html, dates, now) {
  const localArea = new RegExp('impact-loc\\.do\\?dongCode=' + AREA_CODE + '(?:[#&"\\s]|$)');
  if (!localArea.test(html)) throw new Error('기상청 페이지에서 동탄 예보 지역을 확인하지 못했습니다.');

  // The official daily forecast has one date-marked card per day.
  const cards = [...html.matchAll(/<div\s+class="dfs-daily-slide"\s+[^>]*\bdata-date="(\d{4}-\d{2}-\d{2})"[^>]*\bdata-midterm-forecast="(true|false)"[^>]*>/g)];
  if (!cards.length) throw new Error('기상청 일별 예보 표를 찾지 못했습니다.');
  const published = new Map();
  for (const [i, card] of cards.entries()) {
    const [, date, midterm] = card;
    if (!dates.includes(date)) continue;
    if (published.has(date)) throw new Error('기상청 일별 예보에 날짜가 중복됐습니다.');
    const markup = html.slice(card.index + card[0].length, cards[i + 1]?.index ?? html.length);
    const conditions = [...new Set([...markup.matchAll(/<span\s+class="wic\s+[A-Z0-9]+"\s+title="(?:오전 |오후 )?날씨 [^"]+">\s*([가-힣 ]{1,30})\s*<\/span>/g)]
      .map(match => match[1].trim()).filter(Boolean))];
    const probabilities = [...markup.matchAll(/<div\s+class="daily-pop-(?:am|pm|allday)">\s*<strong[^>]*>[^<]+<\/strong>\s*<span>\s*(\d{1,3})%\s*<\/span>/g)]
      .map(match => Number(match[1])).filter(value => value <= 100);
    published.set(date, {
      date,
      min: readTemperature(markup, '최저'),
      max: readTemperature(markup, '최고'),
      precipitationProbability: probabilities.length ? Math.max(...probabilities) : null,
      condition: conditions.length ? conditions.join(' / ') : null,
      icon: forecastIcon(conditions),
      scope: midterm === 'true' ? 'midterm' : 'local',
    });
  }
  const rows = dates.map(date => published.get(date) ?? blankRow(date));
  if (!rows.some(row => row.condition || row.min !== null || row.max !== null)) throw new Error('조회할 수 있는 동탄 예보 값이 없습니다.');
  return { issuedAt: issueTime(html, dates[0], now), rows };
}

function issueTime(html, today, now) {
  // The site shows publication month/day without a year. At the year boundary,
  // prefer the newest valid Seoul timestamp within the previous two days.
  const year = Number(today.slice(0, 4));
  const times = [];
  for (const match of html.matchAll(/<dt>(?:단기예보|중기예보)\([^<]*\):<\/dt>\s*<dd>(\d{1,2})\.(\d{1,2})\.\([가-힣]\)\s+(\d{2}):(\d{2})<\/dd>/g)) {
    const [, month, day, hour, minute] = match;
    for (const candidateYear of [year, year - 1]) {
      const date = [String(candidateYear), month.padStart(2, '0'), day.padStart(2, '0')].join('-');
      const stamp = date + 'T' + hour + ':' + minute + ':00+09:00';
      const instant = new Date(stamp);
      if (!Number.isFinite(instant.getTime()) || instant > now || now - instant > DAY_MS * 2) continue;
      if (seoulCalendar.format(instant) === date) times.push({ stamp, instant });
    }
  }
  return times.sort((a, b) => b.instant - a.instant)[0]?.stamp ?? null;
}

async function fetchLatest(dates, now) {
  const response = await fetch(SOURCE_URL, {
    headers: { Accept: 'text/html', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(7_000),
  });
  if (!response.ok) throw new Error('기상청 조회 응답 ' + response.status);
  const result = readForecast(await response.text(), dates, now);
  const warnings = [];
  if (result.rows.some(row => row.scope === 'midterm')) warnings.push('중기예보는 화성의 기온과 서울·인천·경기도의 날씨·강수확률을 표시합니다.');
  if (result.rows.some(row => row.min === null || row.max === null || row.precipitationProbability === null || !row.condition)) {
    warnings.push('기상청에 표시되지 않은 예보 값은 공란입니다.');
  }
  return { source: SOURCE, sourceUrl: SOURCE_URL, location: LOCATION, ...result, warnings };
}

export async function fetchForecast() {
  const now = new Date();
  const today = seoulCalendar.format(now);
  const start = Date.parse(today + 'T00:00:00Z');
  const dates = Array.from({ length: 7 }, (_, index) => new Date(start + index * DAY_MS).toISOString().slice(0, 10));
  if (cached?.today === today && now.getTime() - cached.savedAt < CACHE_MS) return cached.data;
  if (pending?.today === today) return pending.promise;
  const request = {
    today,
    promise: fetchLatest(dates, now).then(data => {
      cached = { today, savedAt: now.getTime(), data };
      return data;
    }).catch(() => {
      if (cached?.today === today) {
        return { ...cached.data, warnings: [...cached.data.warnings, '기상청 연결이 지연되어 마지막으로 조회한 예보를 표시합니다.'] };
      }
      return {
        source: SOURCE, sourceUrl: SOURCE_URL, location: LOCATION, issuedAt: null, rows: dates.map(blankRow),
        warnings: ['기상청에서 동탄 예보를 가져오지 못했습니다. 잠시 뒤 다시 조회해 주세요.'],
      };
    }).finally(() => {
      if (pending === request) pending = null;
    }),
  };
  pending = request;
  return request.promise;
}
