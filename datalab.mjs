import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const ENDPOINT = 'https://naverapihub.apigw.ntruss.com/search-trend/v1/search';
const SOURCE_URL = 'https://datalab.naver.com/keyword/trendSearch.naver';
const DAY = 86_400_000;
const CACHE_MS = 4 * 60 * 60_000;
const GROUPS = [
  { groupName: '경량패딩', keywords: ['경량패딩', '경량 패딩'] },
  { groupName: '기모 맨투맨', keywords: ['기모맨투맨', '기모 맨투맨'] },
  { groupName: '니트', keywords: ['니트'] },
  { groupName: '기모 바지', keywords: ['기모바지', '기모 바지'] },
  { groupName: '방수 점퍼', keywords: ['방수점퍼', '방수 점퍼'] },
];
const CONNECTION_ERROR = '네이버 데이터랩 연결 설정을 확인해 주세요.';
const RESPONSE_ERROR = '네이버 데이터랩 응답을 확인하지 못했어요. 잠시 후 다시 조회해 주세요.';

function periodFor(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const date = Object.fromEntries(parts.map(part => [part.type, part.value]));
  // DataLab can lag behind today. Compare two complete seven-day windows.
  const end = Date.parse(`${date.year}-${date.month}-${date.day}T00:00:00Z`) - 2 * DAY;
  const dates = Array.from({ length: 14 }, (_, index) => new Date(end - (13 - index) * DAY).toISOString().slice(0, 10));
  return { startDate: dates[0], endDate: dates.at(-1), timeUnit: 'date', dates };
}

async function loadCredentials({ env, readFileImpl, home }) {
  let clientId = env.NAVER_CLIENT_ID?.trim();
  let clientSecret = env.NAVER_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    const file = env.LOTTE_SALES_NAVER_SETTINGS?.trim()
      || path.join(home, 'OneDrive', 'Desktop', 'lotteon-smartstore-v36-main', 'data', 'naver-api-settings.json');
    try {
      const saved = JSON.parse((await readFileImpl(file, 'utf8')).replace(/^\uFEFF/, ''));
      clientId = typeof saved.clientId === 'string' ? saved.clientId.trim() : '';
      clientSecret = typeof saved.clientSecret === 'string' ? saved.clientSecret.trim() : '';
    } catch { throw new Error(CONNECTION_ERROR); }
  }
  if (!/^\S{5,200}$/.test(clientId) || !/^\S{5,200}$/.test(clientSecret)) throw new Error(CONNECTION_ERROR);
  return { clientId, clientSecret };
}

const rounded = (value, digits = 2) => Number(value.toFixed(digits));

function normalizePayload(payload, period) {
  if (payload?.startDate !== period.startDate || payload?.endDate !== period.endDate
    || payload?.timeUnit !== 'date' || !Array.isArray(payload.results) || payload.results.length !== GROUPS.length) {
    throw new Error(RESPONSE_ERROR);
  }
  const validDates = new Set(period.dates);
  const warnings = [];
  const rows = GROUPS.map(group => {
    const matches = payload.results.filter(result => result?.title === group.groupName);
    if (matches.length !== 1 || !Array.isArray(matches[0].data)
      || !Array.isArray(matches[0].keywords)
      || JSON.stringify(matches[0].keywords) !== JSON.stringify(group.keywords)) throw new Error(RESPONSE_ERROR);
    const points = new Map();
    for (const point of matches[0].data) {
      if (!validDates.has(point?.period) || points.has(point.period)
        || typeof point.ratio !== 'number' || !Number.isFinite(point.ratio)
        || point.ratio < 0 || point.ratio > 100) throw new Error(RESPONSE_ERROR);
      points.set(point.period, point.ratio);
    }
    const priorDates = period.dates.slice(0, 7);
    const recentDates = period.dates.slice(7);
    const missingPrior = priorDates.filter(date => !points.has(date)).length;
    const missingRecent = recentDates.filter(date => !points.has(date)).length;
    // Omitted dates are unknown, not zero; a partial week is not a seven-day average.
    const prior = missingPrior ? null : priorDates.reduce((sum, date) => sum + points.get(date), 0) / 7;
    const recent = missingRecent ? null : recentDates.reduce((sum, date) => sum + points.get(date), 0) / 7;
    if (missingPrior || missingRecent) {
      warnings.push(`${group.groupName}: 이전 7일 ${missingPrior}일·최근 7일 ${missingRecent}일의 자료가 없어 해당 평균과 증감률을 표시하지 않아요.`);
    } else if (prior === 0) {
      warnings.push(`${group.groupName}: 이전 7일 평균이 0이라 증감률을 계산하지 않아요.`);
    }
    return {
      title: group.groupName,
      recentAverage: recent === null ? null : rounded(recent),
      priorAverage: prior === null ? null : rounded(prior),
      changePercent: recent === null || prior === null || prior === 0 ? null : rounded((recent - prior) / prior * 100, 1),
    };
  });
  return {
    source: '네이버 데이터랩 검색어 트렌드', sourceUrl: SOURCE_URL,
    startDate: period.startDate, endDate: period.endDate, rows, warnings,
  };
}

// Dependency injection keeps tests independent of credentials, network and the registrar.
export function createDatalabClient({ fetchImpl = fetch, readFileImpl = readFile, env = process.env, home = homedir(), clock = () => new Date() } = {}) {
  let cache;
  const pending = new Map();
  return async function fetchTrends() {
    const now = clock();
    const period = periodFor(now);
    const key = `${period.startDate}/${period.endDate}`;
    if (cache?.key === key && cache.expires > now.getTime()) return structuredClone(cache.value);
    if (pending.has(key)) return structuredClone(await pending.get(key));
    const request = (async () => {
      const credentials = await loadCredentials({ env, readFileImpl, home });
      let response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { 'Content-Type': 'application/json', 'X-NCP-APIGW-API-KEY-ID': credentials.clientId, 'X-NCP-APIGW-API-KEY': credentials.clientSecret },
          body: JSON.stringify({ startDate: period.startDate, endDate: period.endDate, timeUnit: 'date', keywordGroups: GROUPS }),
        });
      } catch { throw new Error('네이버 데이터랩 자료를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'); }
      if (!response.ok) {
        if ([401, 403].includes(response.status)) throw new Error('네이버 데이터랩 연결 설정과 사용 권한을 확인해 주세요.');
        if (response.status === 429) throw new Error('네이버 데이터랩 조회가 잠시 제한됐어요. 잠시 후 다시 시도해 주세요.');
        throw new Error('네이버 데이터랩 자료를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
      }
      let payload;
      try { payload = await response.json(); } catch { throw new Error(RESPONSE_ERROR); }
      const result = normalizePayload(payload, period);
      cache = { key, expires: clock().getTime() + CACHE_MS, value: result };
      return result;
    })();
    pending.set(key, request);
    try { return structuredClone(await request); } finally { pending.delete(key); }
  };
}

export const fetchDatalabTrends = createDatalabClient();
