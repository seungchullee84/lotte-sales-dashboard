import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeReport, summarize, mergeReports} from './sales-model.js';

// Synthetic small numbers only; no account data or actual sales records.
const values = (gross = 0, priorGross = 0) => ({quantity: 1, gross, net: gross - 1, priorGross});
const row = (date, gross = 0, priorGross = 0) => ({date, department: values(gross, priorGross), online: values(2, 1), mobile: values(-1, 0)});
const report = rows => ({schema: 1, store: '테스트점', brand: '검증용', source: '합성 테스트', rows});
const throwsCode = (fn, code) => assert.throws(fn, error => error.code === code);

test('normalization sorts and clones while preserving signed integer daily values', () => {
  const raw = report([row('2024-02-29', -3, 2), row('2024-02-28', 7, 4)]);
  const before = structuredClone(raw), normalized = normalizeReport(raw);
  assert.deepEqual(raw, before);
  assert.deepEqual(normalized.rows.map(r => r.date), ['2024-02-28', '2024-02-29']);
  assert.equal(normalized.rows[1].department.gross, -3);
  normalized.rows[0].department.gross = 99;
  assert.equal(raw.rows[1].department.gross, 7);
});

test('strict calendar dates reject rollover, non-leap days, time suffixes and duplicates', () => {
  for (const date of ['2023-02-29', '1900-02-29', '2024-04-31', '2024-13-01', '0000-01-01', '2024-2-01', '2024-01-01T00:00:00Z']) {
    throwsCode(() => normalizeReport(report([row(date)])), 'INVALID_DATE');
  }
  assert.equal(normalizeReport(report([row('2000-02-29')])).rows.length, 1);
  throwsCode(() => normalizeReport(report([row('2024-01-01'), row('2024-01-01')])), 'DUPLICATE_DATE');
});

test('missing, nonnumeric, fractional and unsafe figures cannot become zero', () => {
  for (const bad of [null, undefined, '12', NaN, Infinity, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
    const raw = report([row('2024-01-01')]); raw.rows[0].online.gross = bad;
    throwsCode(() => normalizeReport(raw), 'INVALID_NUMBER');
  }
  const raw = report([row('2024-01-01')]); delete raw.rows[0].mobile.priorGross;
  throwsCode(() => normalizeReport(raw), 'MISSING_VALUE');
  delete raw.rows[0].mobile;
  throwsCode(() => normalizeReport(raw), 'INVALID_OBJECT');
});

test('inclusive windows keep only actual days and channel-specific values', () => {
  const raw = report([row('2024-01-01', 5, 4), row('2024-01-03', -2, 1), row('2024-01-04', 9, 3)]);
  const summary = summarize(raw, {start: '2024-01-01', end: '2024-01-03', channel: 'department'});
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.daily.map(r => [r.date, r.value]), [['2024-01-01', 5], ['2024-01-03', -2]]);
  assert.deepEqual(summary.coverage, {expectedDays: 3, observedDays: 2, missingDays: 1});
  assert.deepEqual(summary.comparison, {available: true, current: 3, prior: 5, delta: -2, percentage: -40, status: 'comparable'});
  assert.equal(summary.channels.online.gross, 4);
  assert.equal(summarize(raw, {start: '2024-01-03', end: '2024-01-03', channel: 'all'}).total, -1);
});

test('zero and negative comparison baselines are not invented percentages', () => {
  for (const [current, prior, status] of [[5, 0, 'zero-baseline'], [0, 0, 'both-zero'], [-2, 0, 'zero-baseline'], [2, -1, 'negative-baseline']]) {
    const result = summarize(report([row('2024-01-01', current, prior)]), {channel: 'department'}).comparison;
    assert.equal(result.status, status);
    assert.equal(result.percentage, null);
    assert.equal(result.delta, current - prior);
  }
  const net = summarize(report([row('2024-01-01', 5, 3)]), {metric: 'net', channel: 'department'});
  assert.equal(net.total, 4);
  assert.equal(net.comparison.available, false);
  assert.equal(net.comparison.prior, null);
});

test('no observations are distinct from observed zero sales', () => {
  const empty = summarize(report([]));
  assert.equal(empty.hasData, false); assert.equal(empty.total, null);
  assert.equal(empty.comparison.status, 'no-data');
  const outside = summarize(report([row('2024-01-01')]), {start: '2024-02-01', end: '2024-02-03'});
  assert.equal(outside.total, null); assert.equal(outside.coverage.missingDays, 3);
  assert.equal(summarize(report([row('2024-01-01')]), {channel: 'department'}).total, 0);
});

test('invalid query choices and unsafe aggregate arithmetic fail explicitly', () => {
  const raw = report([row('2024-01-01', 1)]);
  throwsCode(() => summarize(raw, {start: '2024-01-02', end: '2024-01-01'}), 'INVALID_WINDOW');
  throwsCode(() => summarize(raw, {channel: 'unknown'}), 'INVALID_CHANNEL');
  throwsCode(() => summarize(raw, {metric: 'priorGross'}), 'INVALID_METRIC');
  throwsCode(() => summarize(raw, {start: '2024-02-30'}), 'INVALID_DATE');
  throwsCode(() => summarize(report([row('2024-01-01', Number.MAX_SAFE_INTEGER), row('2024-01-02', 1)]), {channel: 'department'}), 'TOTAL_OVERFLOW');
});

test('overlapping imports replace whole rows, are idempotent, and preserve inputs', () => {
  const base = report([row('2024-01-01', 2), row('2024-01-02', 3)]);
  const incoming = report([row('2024-01-02', -1), row('2024-01-03', 4)]);
  const before = structuredClone([base, incoming]), merged = mergeReports(base, incoming);
  assert.deepEqual(merged.rows.map(r => r.department.gross), [2, -1, 4]);
  assert.deepEqual(mergeReports(merged, incoming), merged);
  assert.deepEqual([base, incoming], before);
  throwsCode(() => mergeReports(base, {...incoming, store: '다른점'}), 'REPORT_MISMATCH');
  throwsCode(() => mergeReports(base, {...incoming, source: '다른 출처'}), 'REPORT_MISMATCH');
});
