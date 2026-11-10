import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { normalizeReport, mergeReports, SalesDataError } from './sales-model.js';
import { fetchWeatherComparison } from './weather.mjs';
import { fetchForecast } from './forecast.mjs';
import { fetchDatalabTrends } from './datalab.mjs';

const port = Number(process.env.LOTTE_SALES_PORT || 58123);
const origin = 'http://127.0.0.1:' + port;
const dataFolder = new URL('./data/', import.meta.url);
const reportFile = new URL('report.json', dataFolder);
const replacement = new URL('report.next.json', dataFolder);
const priorMonthFile = new URL('prior-month.json', dataFolder);
const emptyReport = { schema: 1, store: '동탄점', brand: '지오다노', source: '롯데백화점 파트너포털', rows: [] };
const paths = new Map([
  ['/', ['index.html', 'text/html']],
  ['/styles.css', ['styles.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/sales-model.js', ['sales-model.js', 'text/javascript']],
  ['/portal-reader.js', ['portal-reader.js', 'text/javascript']],
  ['/weather-view.js', ['weather-view.js', 'text/javascript']],
]);
async function readReport(fallback = emptyReport) {
  try { return normalizeReport(JSON.parse(await readFile(reportFile, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};
function reply(res, status, body, type = 'application/json') {
  res.writeHead(status, { ...headers, 'Content-Type': type + '; charset=utf-8' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
async function readJson(req) {
  let bytes = 0;
  const parts = [];
  for await (const part of req) {
    bytes += part.length;
    if (bytes > 2 * 1024 * 1024) throw new Error('가져올 매출 자료는 2MB 이하여야 해요.');
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new Error('포털에서 복사한 매출 자료인지 확인해 주세요.'); }
}
let queue = Promise.resolve();
async function updateReport(data) {
  const change = queue.then(async () => {
    const report = mergeReports(await readReport({ ...data, rows: [] }), data);
    await mkdir(dataFolder, { recursive: true });
    await writeFile(replacement, JSON.stringify(report, null, 2) + '\n', 'utf8');
    try { await rename(replacement, reportFile); }
    catch (error) { await rm(replacement, { force: true }).catch(() => {}); throw error; }
    return report;
  });
  queue = change.catch(() => {});
  return change;
}
const weather = new Map();
function weatherFor(start, end) {
  const key = start + '/' + end;
  const old = weather.get(key);
  if (old && old.expires > Date.now()) return old.promise;
  if (weather.size >= 20) weather.delete(weather.keys().next().value);
  const promise = fetchWeatherComparison(start, end).catch(error => {
    weather.delete(key);
    throw error;
  });
  weather.set(key, { promise, expires: Date.now() + 5 * 60_000 });
  return promise;
}
const server = createServer(async (req, res) => {
  if (req.headers.host !== '127.0.0.1:' + port) return reply(res, 403, { error: '이 컴퓨터에서 열어 주세요.' });
  const url = new URL(req.url, origin);
  if (url.pathname === '/api/report' && req.method === 'POST') {
    if (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
      return reply(res, 403, { error: '이 화면에서 매출 자료를 가져와 주세요.' });
    }
    try {
      const input = normalizeReport(await readJson(req));
      if (!input.rows.length) throw new Error('가져올 일자별 매출이 없어요.');
      return reply(res, 200, { report: await updateReport(input), count: input.rows.length });
    } catch (error) {
      const userError = error instanceof SalesDataError || !error.code;
      return reply(res, userError ? 400 : 500, { error: userError ? error.message : '매출을 저장하지 못했어요.' });
    }
  }
  if (req.method !== 'GET') return reply(res, 405, { error: '지원하지 않는 요청이에요.' });
  if (url.pathname === '/api/forecast' || url.pathname === '/api/datalab') {
    const provider = url.pathname === '/api/forecast' ? fetchForecast : fetchDatalabTrends;
    try { return reply(res, 200, await provider()); }
    catch { return reply(res, 502, { error: '자료를 가져오지 못했어요. 잠시 후 다시 조회해 주세요.' }); }
  }
  if (url.pathname === '/api/weather') {
    try { return reply(res, 200, await weatherFor(url.searchParams.get('start'), url.searchParams.get('end'))); }
    catch { return reply(res, 502, { error: '기상청 자료를 불러오지 못했어요. 잠시 후 조회를 눌러 주세요.' }); }
  }
  try {
    if (url.pathname === '/api/health') return reply(res, 200, { app: 'lotte-sales-dashboard' });
    if (url.pathname === '/api/report') return reply(res, 200, await readReport());
    if (url.pathname === '/api/prior-month') {
      try { return reply(res, 200, JSON.parse(await readFile(priorMonthFile, 'utf8'))); }
      catch (error) { if (error.code === 'ENOENT') return reply(res, 200, null); throw error; }
    }
    if (paths.has(url.pathname)) {
      const [file, type] = paths.get(url.pathname);
      return reply(res, 200, await readFile(new URL('./' + file, import.meta.url)), type);
    }
    return reply(res, 404, { error: '화면을 찾을 수 없어요.' });
  } catch {
    return reply(res, 500, { error: '프로그램 자료를 열지 못했어요.' });
  }
});
server.listen(port, '127.0.0.1', () => console.log('동탄점 매출 분석기 ' + origin));
