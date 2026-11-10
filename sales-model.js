/** Pure daily-report model. Amounts are integer KRW; missing days are never invented. */
export const CHANNELS = Object.freeze(['department', 'online', 'mobile']);
export const METRICS = Object.freeze(['gross', 'net', 'quantity']);
const FIELDS = ['quantity', 'gross', 'net', 'priorGross'];
const DAY_MS = 86400000;
const MAX_ROWS = 100000;

export class SalesDataError extends Error {
  constructor(code, field, message) {
    super(`${field}: ${message}`);
    this.name = 'SalesDataError';
    this.code = code;
    this.field = field;
  }
}

const fail = (code, field, message) => { throw new SalesDataError(code, field, message); };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('INVALID_OBJECT', field, '객체 형식이어야 합니다.');
  }
  return value;
}
function label(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('INVALID_LABEL', field, '200자 이내의 이름을 입력해 주세요.');
  }
  return value.trim();
}
function date(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail('INVALID_DATE', field, '날짜는 YYYY-MM-DD 형식이어야 합니다.');
  }
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) {
    fail('INVALID_DATE', field, '존재하지 않는 날짜입니다.');
  }
  return value;
}
function integer(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail('INVALID_NUMBER', field, '정확하게 표현할 수 있는 정수여야 합니다. 금액 단위는 원입니다.');
  }
  return Object.is(value, -0) ? 0 : value;
}
function add(a, b, field) {
  const result = a + b;
  if (!Number.isSafeInteger(result)) fail('TOTAL_OVERFLOW', field, '합계가 정확하게 표현할 수 있는 정수 범위를 넘었습니다.');
  return Object.is(result, -0) ? 0 : result;
}
const zero = () => ({quantity: 0, gross: 0, net: 0, priorGross: 0});
function addTotals(target, values, field) {
  for (const key of FIELDS) target[key] = add(target[key], values[key], `${field}.${key}`);
  return target;
}
function selectedTotals(row, channel) {
  if (channel !== 'all') return {...row[channel]};
  return CHANNELS.reduce((total, key) => addTotals(total, row[key], `${row.date}.all`), zero());
}

/** Validate and clone known fields. Duplicate dates must be resolved explicitly by mergeReports. */
export function normalizeReport(raw) {
  object(raw, 'report');
  if (raw.schema !== 1) fail('INVALID_SCHEMA', 'schema', '지원하는 보고서 버전은 1입니다.');
  const report = {schema: 1, store: label(raw.store, 'store'), brand: label(raw.brand, 'brand'), source: label(raw.source, 'source')};
  if (!Array.isArray(raw.rows) || raw.rows.length > MAX_ROWS) {
    fail('INVALID_ROWS', 'rows', `일자별 자료는 ${MAX_ROWS}행 이하의 배열이어야 합니다.`);
  }
  const seen = new Set();
  report.rows = raw.rows.map((input, index) => {
    const field = `rows[${index}]`;
    object(input, field);
    const row = {date: date(input.date, `${field}.date`)};
    if (seen.has(row.date)) fail('DUPLICATE_DATE', `${field}.date`, `${row.date} 자료가 중복되었습니다.`);
    seen.add(row.date);
    for (const channel of CHANNELS) {
      const values = object(input[channel], `${field}.${channel}`);
      row[channel] = {};
      for (const key of FIELDS) {
        if (!own(values, key)) fail('MISSING_VALUE', `${field}.${channel}.${key}`, '값이 없습니다. 미확인 값을 0으로 처리할 수 없습니다.');
        row[channel][key] = integer(values[key], `${field}.${channel}.${key}`);
      }
    }
    return row;
  }).sort((a, b) => a.date.localeCompare(b.date));
  return report;
}

function comparison(totals, metric, hasData) {
  if (!hasData || metric !== 'gross') {
    return {available: false, current: hasData ? totals[metric] : null, prior: null, delta: null, percentage: null, status: hasData ? 'unsupported-metric' : 'no-data'};
  }
  const current = totals.gross, prior = totals.priorGross;
  const delta = add(current, -prior, 'comparison.delta');
  if (prior === 0) return {available: true, current, prior, delta, percentage: null, status: current === 0 ? 'both-zero' : 'zero-baseline'};
  if (prior < 0) return {available: true, current, prior, delta, percentage: null, status: 'negative-baseline'};
  return {available: true, current, prior, delta, percentage: (delta / prior) * 100, status: 'comparable'};
}

/**
 * Dates are inclusive. Only observed rows appear in daily; coverage reports gaps.
 * channel=all adds all three channels, so callers must establish that they are disjoint.
 * priorGross is the supplied prior-period amount; no previous-year rows are inferred.
 */
export function summarize(raw, options = {}) {
  const report = normalizeReport(raw);
  object(options, 'options');
  const metric = options.metric ?? 'gross', channel = options.channel ?? 'all';
  if (!METRICS.includes(metric)) fail('INVALID_METRIC', 'metric', 'gross, net, quantity 중 하나여야 합니다.');
  if (channel !== 'all' && !CHANNELS.includes(channel)) fail('INVALID_CHANNEL', 'channel', 'all, department, online, mobile 중 하나여야 합니다.');
  const bound = (value, field, fallback) => value === undefined || value === null || value === '' ? fallback : date(value, field);
  const start = bound(options.start, 'start', report.rows[0]?.date ?? null);
  const end = bound(options.end, 'end', report.rows.at(-1)?.date ?? null);
  if (start !== null && end !== null && start > end) fail('INVALID_WINDOW', 'start/end', '시작일이 종료일보다 늦습니다.');
  const rows = report.rows.filter(row => (start === null || row.date >= start) && (end === null || row.date <= end));
  const totals = zero(), channels = Object.fromEntries(CHANNELS.map(key => [key, zero()]));
  const daily = rows.map(row => {
    for (const key of CHANNELS) addTotals(channels[key], row[key], `channels.${key}`);
    const values = selectedTotals(row, channel);
    addTotals(totals, values, 'totals');
    return {date: row.date, value: values[metric], ...values};
  });
  const expectedDays = start !== null && end !== null ? (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / DAY_MS + 1 : 0;
  const hasData = rows.length > 0;
  return {
    start, end, channel, metric, hasData, rowCount: rows.length,
    total: hasData ? totals[metric] : null, totals, channels, daily,
    comparison: comparison(totals, metric, hasData),
    coverage: {expectedDays, observedDays: rows.length, missingDays: Math.max(0, expectedDays - rows.length)}
  };
}

/** New rows replace the complete same-date row, never add overlapping exports twice. */
export function mergeReports(base, incoming) {
  const previous = normalizeReport(base), next = normalizeReport(incoming);
  for (const key of ['store', 'brand', 'source']) {
    if (previous[key] !== next[key]) fail('REPORT_MISMATCH', key, '같은 매장·브랜드·출처의 보고서만 합칠 수 있습니다.');
  }
  const rows = new Map(previous.rows.map(row => [row.date, row]));
  for (const row of next.rows) rows.set(row.date, row);
  return normalizeReport({...previous, rows: [...rows.values()]});
}
