import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createDatalabClient } from './datalab.mjs';

const env = { NAVER_CLIENT_ID: 'synthetic-id', NAVER_CLIENT_SECRET: 'synthetic-secret' };
const clock = () => new Date('2026-11-10T15:30:00Z'); // November 11 in Seoul.
function responseFor(options, transform = value => value) {
  const request = JSON.parse(options.body);
  const start = Date.parse(request.startDate + 'T00:00:00Z');
  const payload = { ...request, results: request.keywordGroups.map(group => ({
    title: group.groupName, keywords: group.keywords,
    data: Array.from({ length: 14 }, (_, i) => ({ period: new Date(start + i * 86_400_000).toISOString().slice(0, 10), ratio: i < 7 ? 20 : 30 })),
  })) };
  return Response.json(transform(payload));
}

test('fixed HUB endpoint, Seoul cutoff, five groups and complete seven-day comparison', async () => {
  const client = createDatalabClient({ env, clock, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://naverapihub.apigw.ntruss.com/search-trend/v1/search');
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['X-NCP-APIGW-API-KEY'], env.NAVER_CLIENT_SECRET);
    const request = JSON.parse(options.body);
    assert.equal(request.startDate, '2026-10-27');
    assert.equal(request.endDate, '2026-11-09');
    assert.deepEqual(request.keywordGroups.map(group => group.groupName), ['경량패딩', '기모 맨투맨', '니트', '기모 바지', '방수 점퍼']);
    return responseFor(options);
  } });
  const result = await client();
  assert.equal(result.rows.length, 5);
  assert.deepEqual(result.rows[0], { title: '경량패딩', recentAverage: 30, priorAverage: 20, changePercent: 50 });
  assert.deepEqual(result.warnings, []);
  assert(!JSON.stringify(result).includes('synthetic-secret'));
});

test('missing days remain unknown and zero baseline never creates a percentage', async () => {
  const client = createDatalabClient({ env, clock, fetchImpl: async (_url, options) => responseFor(options, payload => {
    payload.results[0].data.splice(0, 1);
    payload.results[1].data.splice(10, 1);
    payload.results[2].data.forEach(point => { point.ratio = 0; });
    return payload;
  }) });
  const result = await client();
  assert.equal(result.rows[0].priorAverage, null);
  assert.equal(result.rows[0].recentAverage, 30);
  assert.equal(result.rows[0].changePercent, null);
  assert.equal(result.rows[1].recentAverage, null);
  assert.equal(result.rows[2].priorAverage, 0);
  assert.equal(result.rows[2].changePercent, null);
  assert.equal(result.warnings.length, 3);
});

test('rejects duplicate dates, wrong dates, invalid ratios and mismatched groups', async () => {
  for (const transform of [
    payload => { payload.results[0].data.push(payload.results[0].data[0]); return payload; },
    payload => { payload.results[0].data[0].period = '2026-10-26'; return payload; },
    payload => { payload.results[0].data[0].ratio = 101; return payload; },
    payload => { payload.results[0].data[0].ratio = null; return payload; },
    payload => { payload.results[0].keywords = ['다른 검색어']; return payload; },
    payload => { payload.results[0].title = '다른 제목'; return payload; },
  ]) {
    const client = createDatalabClient({ env, clock, fetchImpl: async (_url, options) => responseFor(options, transform) });
    await assert.rejects(client(), /응답을 확인하지 못했어요/);
  }
});

test('reads explicit settings path only on server and supports the existing default', async () => {
  for (const settingsEnv of [{ LOTTE_SALES_NAVER_SETTINGS: 'C:/private/approved.json' }, {}]) {
    let readPath;
    const client = createDatalabClient({ env: settingsEnv, home: 'C:/synthetic-user', clock,
      readFileImpl: async (file, encoding) => {
        readPath = file; assert.equal(encoding, 'utf8');
        return JSON.stringify({ clientId: env.NAVER_CLIENT_ID, clientSecret: env.NAVER_CLIENT_SECRET });
      }, fetchImpl: async (_url, options) => responseFor(options) });
    await client();
    assert.equal(readPath, settingsEnv.LOTTE_SALES_NAVER_SETTINGS || path.join('C:/synthetic-user', 'OneDrive', 'Desktop', 'lotteon-smartstore-v36-main', 'data', 'naver-api-settings.json'));
  }
});

test('coalesces requests, caches success for four hours, and does not return mutable cache objects', async () => {
  let calls = 0;
  let now = clock();
  const client = createDatalabClient({ env, clock: () => now, fetchImpl: async (_url, options) => {
    calls++; await new Promise(resolve => setTimeout(resolve, 5)); return responseFor(options);
  } });
  const [a, b] = await Promise.all([client(), client()]);
  assert.equal(calls, 1);
  a.rows[0].recentAverage = 999;
  assert.equal(b.rows[0].recentAverage, 30);
  now = new Date(now.getTime() + 4 * 60 * 60_000 - 1);
  assert.equal((await client()).rows[0].recentAverage, 30);
  assert.equal(calls, 1);
  now = new Date(now.getTime() + 1);
  await client(); assert.equal(calls, 2);
});

test('Seoul date change requests a new complete period even while cache is fresh', async () => {
  let now = new Date('2026-11-10T14:59:00Z');
  let calls = 0;
  const client = createDatalabClient({ env, clock: () => now, fetchImpl: async (_url, options) => {
    calls++; return responseFor(options);
  } });
  const first = await client();
  now = new Date('2026-11-10T15:01:00Z');
  const second = await client();
  assert.equal(calls, 2);
  assert.notEqual(first.endDate, second.endDate);
});

test('failures do not leak secrets or paths and are not cached', async () => {
  let calls = 0;
  const client = createDatalabClient({ env, clock, fetchImpl: async (_url, options) => {
    calls++; return calls === 1 ? new Response('private upstream detail', { status: 403 }) : responseFor(options);
  } });
  await assert.rejects(client(), /사용 권한/);
  await client(); assert.equal(calls, 2);
  const missing = createDatalabClient({ env: {}, clock, readFileImpl: async () => { throw new Error('private path'); } });
  await assert.rejects(missing(), error => error.message === '네이버 데이터랩 연결 설정을 확인해 주세요.');
  const network = createDatalabClient({ env, clock, fetchImpl: async () => { throw new Error('synthetic-secret'); } });
  await assert.rejects(network(), error => !error.message.includes('synthetic-secret'));
});
