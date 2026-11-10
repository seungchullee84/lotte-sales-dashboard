import { CHANNELS, normalizeReport, summarize } from './sales-model.js';
import { buildPortalBookmarklet } from './portal-reader.js';
import { makeWeatherIcon, showWeeklyPlan } from './weather-view.js';

const el = id => document.getElementById(id);
const labels = { all: '전체 채널', department: '백화점', online: '온라인', mobile: '모바일' };
const metrics = { gross: '총매출', quantity: '판매수량' };
const integer = new Intl.NumberFormat('ko-KR');
const percent = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: 'always' });
const compact = new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 });
const dayMs = 86400000;
let report;
let referenceMonth;
let view;
let weatherRequest;
let loadedWeather;
let selectedDates;
const dateMs = date => Date.parse(date + 'T00:00:00Z');
const dateText = ms => new Date(ms).toISOString().slice(0, 10);
const amount = (value, metric = 'gross') => value == null ? '—' : integer.format(value) + (metric === 'quantity' ? '개' : '원');
const compactDate = date => date.slice(5).replace('-', '.');
const svgNS = 'http://www.w3.org/2000/svg';
function svg(name, attrs = {}, value) {
  const node = document.createElementNS(svgNS, name);
  for (const [key, val] of Object.entries(attrs)) node.setAttribute(key, val);
  if (value != null) node.textContent = value;
  return node;
}
function line(x1, y1, x2, y2, className) {
  return svg('line', { x1, y1, x2, y2, class: className });
}
function empty(container, message) {
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = message;
  container.replaceChildren(p);
}
function message(id, text, error = false) {
  const node = el(id);
  node.hidden = !text;
  node.textContent = text;
  node.classList.toggle('error', error);
}
async function getJson(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '자료를 읽지 못했어요.');
  return result;
}
function getDateBounds() {
  return [report.rows[0]?.date, report.rows.at(-1)?.date];
}
function setRange(start, end) {
  el('start').value = start ?? '';
  el('end').value = end ?? '';
}
function updateReportLabel() {
  const [first, last] = getDateBounds();
  el('store-label').textContent = report.store + ' ' + report.brand + '의 판매 실적을 기간별로 비교해요.';
  el('data-range').textContent = first ? '보유 자료 ' + first + ' ~ ' + last : '저장된 매출 자료 없음';
}
function plotTrend() {
  if (!view) return;
  const area = el('trend');
  if (!view.hasData) return empty(area, '선택한 기간에 매출 자료가 없어요.');
  const width = Math.max(290, Math.round(area.clientWidth));
  const height = 230, left = 48, right = width - 18, top = 12, bottom = 198;
  const compare = view.metric === 'gross';
  const completeReference = compare && referenceMonth?.referenceFor === view.start.slice(0, 7) &&
    view.start.endsWith('-01') && view.end.startsWith(referenceMonth.referenceFor) &&
    referenceMonth.store === report.store && referenceMonth.brand === report.brand;
  const accumulate = (rows, key) => {
    let total = 0;
    return rows.map(row => ({ date: row.date, value: total += row[key] }));
  };
  const current = accumulate(view.daily, 'value');
  const previous = completeReference ? accumulate(referenceMonth.rows.map((channels, i) => ({
    date: referenceMonth.referenceFor + '-' + String(i + 1).padStart(2, '0'),
    gross: view.channel === 'all' ? channels.reduce((sum, value) => sum + value, 0) : channels[CHANNELS.indexOf(view.channel)],
  })), 'gross') : compare ? accumulate(view.daily, 'priorGross') : [];
  const chartEnd = completeReference ? previous.at(-1).date : view.end;
  const currentEnd = current.at(-1).date;
  el('trend-title').textContent = completeReference ? '11월 누적 매출' : '선택 기간 누적 ' + metrics[view.metric];
  el('trend-note').textContent = completeReference
    ? labels[view.channel] + ' 기준. 올해는 ' + compactDate(currentEnd) + '까지, 작년은 11월 전체예요.'
    : labels[view.channel] + ' ' + metrics[view.metric] + (compare ? '과 전년실적 누적' : ' 누적');
  el('current-legend').textContent = '올해 누적';
  el('prior-legend').textContent = completeReference ? referenceMonth.month.slice(0, 4) + '년 11월 누적' : '전년 누적';
  const all = [...current, ...previous].map(row => row.value);
  const min = Math.min(0, ...all), max = Math.max(0, ...all);
  const range = (max - min) || 4;
  const stepRaw = range / 4;
  const power = 10 ** Math.floor(Math.log10(stepRaw));
  const step = Math.max(1, ([1, 2, 2.5, 5, 10].find(n => n * power >= stepRaw) || 10) * power);
  const low = Math.floor(min / step) * step, high = Math.max(low + step, Math.ceil(max / step) * step);
  const x0 = dateMs(view.start), x1 = dateMs(chartEnd);
  const x = date => x0 === x1 ? (left + right) / 2 : left + (dateMs(date) - x0) / (x1 - x0) * (right - left);
  const y = value => bottom - (value - low) / (high - low) * (bottom - top);
  const chart = svg('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': el('trend-title').textContent + ' 그래프' });
  for (let i = 0; i <= Math.round((high - low) / step); i++) {
    const value = low + i * step, yy = y(value);
    chart.append(line(left, yy, right, yy, 'chart-grid'), svg('text', { x: left - 7, y: yy + 4, 'text-anchor': 'end', 'font-size': 11 }, compact.format(value)));
  }
  const days = Math.round((x1 - x0) / dayMs);
  const count = Math.min(days, width > 560 ? 6 : 4);
  for (let i = 0; i <= count; i++) {
    const date = dateText(x0 + (count ? Math.round(i * days / count) : 0) * dayMs);
    chart.append(svg('text', { x: x(date), y: bottom + 23, 'text-anchor': 'middle', 'font-size': 11 }, compactDate(date)));
  }
  function trace(rows, cls) {
    let path = '', previous;
    for (const row of rows) {
      const continuity = previous != null && dateMs(row.date) - previous === dayMs;
      path += (continuity ? ' L ' : ' M ') + x(row.date) + ' ' + y(row.value);
      previous = dateMs(row.date);
    }
    chart.append(svg('path', { d: path.trim(), class: cls }));
  }
  if (compare) trace(previous, 'chart-prior');
  trace(current, 'chart-current');
  for (const row of current) {
    const point = svg('circle', { cx: x(row.date), cy: y(row.value), r: view.daily.length > 62 ? 2 : 3.5, class: 'chart-point' });
    point.append(svg('title', {}, row.date + ' 누적 ' + amount(row.value, view.metric)));
    chart.append(point);
  }
  if (previous.length) {
    const last = previous.at(-1);
    const point = svg('circle', { cx: x(last.date), cy: y(last.value), r: 3.5, class: 'chart-point chart-point-prior' });
    point.append(svg('title', {}, el('prior-legend').textContent + ' ' + amount(last.value)));
    chart.append(point);
  }
  area.replaceChildren(chart);
}
function plotChannels() {
  const area = el('channel-chart');
  if (!view.hasData) return empty(area, '선택한 기간에 채널 자료가 없어요.');
  const values = CHANNELS.map(key => view.channels[key][view.metric]);
  const min = Math.min(0, ...values), max = Math.max(0, ...values);
  const span = (max - min) || 1;
  const percentOf = n => (n - min) / span * 100;
  const zero = percentOf(0);
  area.replaceChildren(...CHANNELS.map((key, i) => {
    const box = document.createElement('div');
    const caption = document.createElement('div');
    caption.className = 'bar-label';
    const label = document.createElement('span'), value = document.createElement('strong');
    label.textContent = labels[key];
    value.textContent = amount(values[i], view.metric);
    caption.append(label, value);
    const bar = svg('svg', { viewBox: '0 0 100 12', preserveAspectRatio: 'none', class: 'bar', 'aria-hidden': 'true' });
    bar.append(svg('rect', { width: 100, height: 12, class: 'bar-track' }),
      svg('rect', { x: Math.min(zero, percentOf(values[i])), width: Math.abs(percentOf(values[i]) - zero), height: 12, class: 'bar-fill ' + key }),
      line(zero, 0, zero, 12, 'bar-zero'));
    box.append(caption, bar);
    return box;
  }));
}
function cell(row, value, tag = 'td') {
  const node = document.createElement(tag);
  if (tag === 'th') node.scope = 'row';
  node.textContent = value;
  row.append(node);
  return node;
}
function renderDaily() {
  el('daily-rows').replaceChildren(...view.daily.map(day => {
    const row = document.createElement('tr');
    cell(row, day.date, 'th');
    cell(row, amount(day.quantity, 'quantity'));
    cell(row, amount(day.gross));
    cell(row, amount(day.priorGross));
    return row;
  }));
}
function weatherCell(row, entry) {
  const cellNode = cell(row, entry ? '' : '관측 자료 없음');
  if (entry) {
    const reading = document.createElement('div');
    reading.className = 'weather-reading';
    const icon = makeWeatherIcon(entry);
    if (icon) reading.append(icon);
    reading.append('최저 ' + (entry.min == null ? '—' : entry.min + '°') + ' / 최고 ' + (entry.max == null ? '—' : entry.max + '°'));
    const description = document.createElement('small');
    description.textContent = ['강수 ' + (entry.precipitation == null ? '—' : entry.precipitation + ' mm'), entry.condition, entry.kind === 'provisional' ? '당일 잠정' : ''].filter(Boolean).join(' / ');
    cellNode.append(reading, description);
  }
}
async function showWeather(start, end) {
  if (!start || !end) return;
  const key = start + '/' + end;
  if (loadedWeather === key) return;
  loadedWeather = key;
  weatherRequest?.abort();
  const request = weatherRequest = new AbortController();
  el('weather-rows').replaceChildren();
  if ((dateMs(end) - dateMs(start)) / dayMs >= 366) {
    message('weather-status', '날씨 비교는 한 번에 최대 366일을 조회할 수 있어요.');
    return;
  }
  message('weather-status', '선택 기간의 날씨를 확인하는 중이에요.');
  try {
    const query = new URLSearchParams({ start, end });
    const data = await getJson('/api/weather?' + query, { signal: request.signal });
    if (request.signal.aborted) return;
    el('weather-rows').replaceChildren(...data.rows.map(day => {
      const row = document.createElement('tr');
      cell(row, day.date, 'th');
      weatherCell(row, day.current);
      cell(row, day.priorDate ?? '—');
      weatherCell(row, day.prior);
      return row;
    }));
    const missing = data.rows.some(day => day.current == null || day.prior == null);
    const weatherNotes = ['기온은 °C 기준이에요. 강수량의 — 는 원자료 공란이에요.'];
    if (missing) weatherNotes.push('일부 날짜의 관측 자료가 비어 있어요.');
    if (data.rows.some(day => day.current?.kind === 'provisional')) weatherNotes.push('당일 관측값은 바뀔 수 있어요.');
    message('weather-status', weatherNotes.join(' '));
    const url = new URL(data.sourceUrl);
    if (url.protocol === 'https:' && url.hostname === 'www.weather.go.kr') el('weather-source').href = url.href;
    el('weather-source').textContent = data.source + ' ' + data.location;
  } catch (error) {
    if (!request.signal.aborted) {
      loadedWeather = undefined;
      message('weather-status', error.message, true);
    }
  }
}
function render(useDraftDates = false) {
  if (!report) return;
  try {
    const dates = useDraftDates || !selectedDates ? { start: el('start').value, end: el('end').value } : selectedDates;
    view = summarize(report, { ...dates, channel: el('channel').value, metric: el('metric').value });
    selectedDates = { start: view.start, end: view.end };
    const { start, end, hasData, totals, coverage } = view;
    const comparison = summarize(report, { start, end, channel: view.channel, metric: 'gross' }).comparison;
    el('gross').textContent = amount(hasData ? totals.gross : null);
    el('quantity').textContent = amount(hasData ? totals.quantity : null, 'quantity');
    el('change').textContent = comparison.percentage == null ? '—' : percent.format(comparison.percentage) + '%';
    el('prior-label').textContent = comparison.available
      ? '전년 ' + amount(comparison.prior) + (comparison.percentage == null ? ' / 증감률 미표시' : '')
      : '포털 전년실적 기준';
    el('current-period').textContent = start && end ? start + ' ~ ' + end : '선택한 기간';
    el('prior-key').hidden = view.metric !== 'gross';
    message('filter-status', coverage.missingDays > 0 ? coverage.expectedDays + '일 중 ' + coverage.observedDays + '일의 매출 자료가 있어요.' : '');
    plotTrend();
    plotChannels();
    renderDaily();
    showWeather(start, end);
  } catch (error) {
    message('filter-status', error.message, true);
  }
}

el('reader-link').href = buildPortalBookmarklet();
el('refresh-plan').addEventListener('click', () => showWeeklyPlan(getJson));
showWeeklyPlan(getJson);
el('reader-link').addEventListener('click', event => {
  event.preventDefault();
  message('import-status', '이 링크를 Chrome 북마크바에 끌어 놓고, 포털 화면에서 북마크를 눌러 주세요.');
});
document.querySelector('.top-link').addEventListener('click', () => { el('import').open = true; });
el('filters').addEventListener('submit', event => { event.preventDefault(); render(true); });
el('channel').addEventListener('change', () => render());
el('metric').addEventListener('change', () => render());
el('all-days').addEventListener('click', () => { if (report) { setRange(...getDateBounds()); render(true); } });
el('last-seven').addEventListener('click', () => {
  if (!report?.rows.length) return;
  const [first, last] = getDateBounds();
  setRange(dateText(Math.max(dateMs(first), dateMs(last) - 6 * dayMs)), last);
  render(true);
});
el('import-form').addEventListener('submit', async event => {
  event.preventDefault();
  const input = el('import-text'), button = el('import-button');
  button.disabled = true;
  try {
    let incoming;
    try { incoming = JSON.parse(input.value); }
    catch { throw new Error('포털에서 복사한 매출 자료를 붙여넣어 주세요.'); }
    const data = await getJson('/api/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(incoming) });
    report = normalizeReport(data.report);
    input.value = '';
    updateReportLabel();
    const imported = normalizeReport(incoming);
    setRange(imported.rows[0].date, imported.rows.at(-1).date);
    render(true);
    message('import-status', data.count + '일의 매출 자료를 저장했어요.');
  } catch (error) { message('import-status', error.message, true); }
  finally { button.disabled = false; }
});
let plottedWidth;
new ResizeObserver(entries => {
  const width = Math.round(entries[0].contentRect.width);
  if (width !== plottedWidth) {
    plottedWidth = width;
    plotTrend();
  }
}).observe(el('trend'));
try {
  const [loadedReport, prior] = await Promise.all([getJson('/api/report'), getJson('/api/prior-month').catch(() => null)]);
  report = normalizeReport(loadedReport);
  referenceMonth = prior;
  updateReportLabel();
  setRange(...getDateBounds());
  render(true);
} catch (error) {
  message('filter-status', error.message, true);
  message('weather-status', '매출 기간을 읽지 못했어요.', true);
}
