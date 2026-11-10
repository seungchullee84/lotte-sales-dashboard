const iconPaths = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M19 5l-1.4 1.4M6.4 17.6 5 19"/>',
  cloud: '<path d="M6 18h12a4 4 0 0 0 .5-8 6 6 0 0 0-11.5 1 3.5 3.5 0 0 0-1 7z"/>',
  rain: '<path d="M6 14h12a3.5 3.5 0 0 0 .5-7 5 5 0 0 0-9.6 1A3 3 0 0 0 6 14zm2 3-1 3m6-3-1 3m6-3-1 3"/>',
  snow: '<path d="M12 2v20M4 7l16 10M4 17 20 7M9 4l3 3 3-3M9 20l3-3 3 3M4 10l4-1-1-4m13 9-4 1 1 4M4 14l4 1-1 4m13-9-4-1 1-4"/>',
  mix: '<path d="M6 13h12a3.5 3.5 0 0 0 .5-7 5 5 0 0 0-9.6 1A3 3 0 0 0 6 13zm2 3-1 3m8-4v7m-3-5.5 6 4m-6 0 6-4"/>',
  fog: '<path d="M6 12h12a3.5 3.5 0 0 0 .5-7 5 5 0 0 0-9.6 1A3 3 0 0 0 6 12zm-2 4h16m-13 4h10"/>',
  thunder: '<path d="M6 13h12a3.5 3.5 0 0 0 .5-7 5 5 0 0 0-9.6 1A3 3 0 0 0 6 13zm7-2-3 6h4l-2 5"/>',
};
const iconNames = { sun: '운량 적음', cloud: '구름', rain: '비', snow: '눈', mix: '비 또는 눈', fog: '안개', thunder: '뇌우' };

export function weatherKind(entry) {
  if (!entry) return 'unknown';
  if (Object.hasOwn(iconPaths, entry.icon)) return entry.icon;
  const condition = entry.condition || '';
  if (/뇌우|천둥|번개/.test(condition)) return 'thunder';
  if (/진눈깨비|비\s*[/,·와또는]*\s*눈|눈\s*[/,·와또는]*\s*비/.test(condition)) return 'mix';
  if (/눈/.test(condition)) return 'snow';
  if (/비|소나기/.test(condition) || entry.precipitation > 0) return 'rain';
  if (/안개|박무/.test(condition)) return 'fog';
  if (/흐림|구름/.test(condition) || Number.isFinite(entry.cloud) && entry.cloud >= 4) return 'cloud';
  if (/맑음/.test(condition) || Number.isFinite(entry.cloud) && entry.cloud < 4) return 'sun';
  return 'unknown';
}

export function makeWeatherIcon(entry) {
  const kind = weatherKind(entry);
  if (kind === 'unknown') return null;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    class: 'weather-icon weather-' + kind, role: 'img', 'aria-label': entry.condition || iconNames[kind],
  })) svg.setAttribute(key, value);
  svg.innerHTML = iconPaths[kind];
  return svg;
}

const weekday = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', timeZone: 'UTC' });
const percent = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1, signDisplay: 'always' });
const dayLabel = date => weekday.format(new Date(date + 'T00:00:00Z'));
const temperature = value => Number.isFinite(value) ? value + '°' : '미제공';

export function weeklySuggestions(forecast, trends) {
  const days = forecast?.rows || [];
  const cold = days.filter(day => Number.isFinite(day.min) && day.min <= 5);
  const cool = days.filter(day => Number.isFinite(day.max) && day.max <= 13);
  const mild = days.filter(day => Number.isFinite(day.max) && day.max > 13);
  const wet = days.filter(day => ['rain', 'snow', 'mix', 'thunder'].includes(weatherKind(day)) || day.precipitationProbability >= 60);
  const candidates = [];
  if (cold.length) candidates.push({
    title: '경량패딩', weight: cold.length * 2,
    reason: '최저 5°C 이하 예보가 ' + cold.length + '일 있어 출근·등교용 겉옷 진열을 점검해 보세요.',
  });
  if (cold.length || cool.length) candidates.push({
    title: '기모 맨투맨', weight: cold.length + cool.length,
    reason: '아침 기온이 낮거나 낮 최고기온이 13°C 이하인 날에 입기 좋은 상의를 준비해 보세요.',
  });
  if (mild.length) candidates.push({
    title: '니트', weight: mild.length,
    reason: '낮 최고기온이 13°C를 넘는 날이 ' + mild.length + '일이에요. 겹쳐 입을 수 있는 니트를 함께 보여주세요.',
  });
  if (cold.length >= 2) candidates.push({
    title: '기모 바지', weight: cold.length,
    reason: '아침 추위가 이어지는 날에 맞춰 기모 치노나 트레이닝 바지의 재고를 확인해 보세요.',
  });
  if (wet.length) candidates.push({
    title: '방수 점퍼', weight: wet.length * 2 + 1,
    reason: '강수 예보가 ' + wet.length + '일 있어 해당 날짜에 맞춰 방수 사양이 확인된 겉옷을 준비해 보세요.',
  });
  const byTitle = new Map((trends?.rows || []).map(row => [row.title, row]));
  return candidates.map(item => {
    const trend = byTitle.get(item.title);
    const change = Number.isFinite(trend?.changePercent) ? trend.changePercent : null;
    return { ...item, change, score: item.weight + (change >= 10 ? 2 : change <= -10 ? -2 : 0) };
  }).sort((a, b) => b.score - a.score);
}

const el = id => document.getElementById(id);
function text(tag, value, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  node.textContent = value;
  return node;
}

export async function showWeeklyPlan(getJson) {
  const button = el('refresh-plan');
  button.disabled = true;
  el('forecast-status').textContent = '일주일 예보를 확인하는 중이에요.';
  el('trend-status').textContent = '데이터랩 검색 흐름을 확인하는 중이에요.';
  try {
    const [forecastResult, trendResult] = await Promise.allSettled([getJson('/api/forecast'), getJson('/api/datalab')]);
    const forecast = forecastResult.status === 'fulfilled' ? forecastResult.value : null;
    const trends = trendResult.status === 'fulfilled' ? trendResult.value : null;
    if (forecast) {
      const issued = forecast.issuedAt ? new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit',
      }).format(new Date(forecast.issuedAt)) + ' 발표. ' : '';
      el('forecast-status').textContent = issued + (forecast.warnings || []).join(' ');
      el('forecast-source').href = forecast.sourceUrl;
      el('forecast-days').replaceChildren(...forecast.rows.map(day => {
        const item = text('div', '', 'forecast-day');
        const icon = makeWeatherIcon(day);
        item.append(text('strong', dayLabel(day.date)));
        if (icon) item.append(icon);
        item.append(text('span', day.condition || '예보 미제공', 'forecast-condition'),
          text('span', '최저 ' + temperature(day.min) + ' / 최고 ' + temperature(day.max)),
          text('small', Number.isFinite(day.precipitationProbability) ? '최대 강수확률 ' + day.precipitationProbability + '%' : '강수확률 미제공'));
        return item;
      }));
    } else {
      el('forecast-days').replaceChildren();
      el('forecast-status').textContent = '기상청 예보를 가져오지 못했어요.';
    }
    el('trend-status').textContent = trends
      ? trends.startDate + ' ~ ' + trends.endDate + ' 검색 지수. 최근 7일 평균을 직전 7일과 비교했어요.' + (trends.warnings?.length ? ' 일부 품목은 비교 자료가 부족해요.' : '')
      : '데이터랩 검색 지수를 가져오지 못했어요. 상품 후보에는 확인된 예보를 사용했어요.';
    const ideas = weeklySuggestions(forecast, trends);
    el('prep-list').replaceChildren(...ideas.map((item, index) => {
      const card = text('li', '', 'prep-item');
      const title = index === 0 ? '먼저 점검할 상품 ' + item.title : item.title;
      const signal = item.change === null ? '검색 추세 자료 부족' : '검색 지수 ' + percent.format(item.change) + '%';
      card.append(text('strong', title), text('p', item.reason), text('small', signal, 'trend-signal'));
      return card;
    }));
    if (!ideas.length) el('prep-list').append(text('li', '상품 후보를 제시할 수 있는 예보가 아직 없어요.', 'empty'));
  } finally { button.disabled = false; }
}
