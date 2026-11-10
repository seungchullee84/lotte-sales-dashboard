/** Read only the rendered, complete Nexacro daily sales grid. No portal APIs. */
export function readRenderedPortal(document) {
  const visible = element => {
    if (!element || element.hidden) return false;
    if (typeof element.checkVisibility === 'function' &&
        !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const view = element.ownerDocument?.defaultView;
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      if (node.hidden) return false;
      if (view?.getComputedStyle) {
        const style = view.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' ||
            style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
      }
    }
    const rect = element.getBoundingClientRect?.();
    return !!rect && rect.width > 0 && rect.height > 0;
  };
  const one = (scope, selector, label) => {
    const matches = Array.from(scope.querySelectorAll(selector)).filter(visible);
    if (matches.length !== 1) throw new Error(`${label}을 한 곳으로 확인하지 못했습니다. 일별 매출 조회 화면 하나를 열어 주세요.`);
    return matches[0];
  };
  const text = element => String(
    /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) ? element.value : element.innerText ?? element.textContent ?? ''
  ).replace(/[\u200b\ufeff]/g, '').replace(/\u00a0/g, ' ').trim();
  const monthInput = one(document,
    'input[id*="POSISIDttdtSlngListM"][id$="cal_SlngYYmm_calendaredit_input"]', '조회 월');
  const frameId = monthInput.id.split('_form_')[0];
  const root = document.getElementById(frameId);
  if (!root || !root.contains(monthInput)) throw new Error('현재 일별 매출 화면의 범위를 확인하지 못했습니다.');
  const storeInput = one(root, '[id$="div_cstr_edt_Name_input"]', '점포');
  const brandInput = one(root, '[id$="div_itmno_edt_Name_input"]', '브랜드');
  const countText = one(root, '[id$="div_Count_sta_TotalTextBoxElement"]', '총 조회 건수');
  const before = { month: text(monthInput), store: text(storeInput), brand: text(brandInput), rowCount: text(countText) };
  const rows = new Map();
  // DOM columns 4/5 are hidden temporary columns. AX column positions differ.
  const required = new Set([0, 1, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 23, 24, 25, 26]);
  for (const element of root.querySelectorAll('[id*="_grd_Master_body_gridrow_"][id*="_cell_"]')) {
    const match = /_grd_Master_body_gridrow_(\d+)_cell_(\d+)_(\d+)$/.exec(element.id);
    if (!match || match[1] !== match[2] || !required.has(Number(match[3])) || !visible(element)) continue;
    const index = Number(match[1]), column = Number(match[3]);
    if (!rows.has(index)) rows.set(index, { index, cells: {} });
    const row = rows.get(index);
    if (Object.prototype.hasOwnProperty.call(row.cells, column)) throw new Error('같은 표 셀이 중복으로 표시되어 있습니다. 조회가 끝난 뒤 다시 실행해 주세요.');
    row.cells[column] = text(element);
  }
  const after = { month: text(monthInput), store: text(storeInput), brand: text(brandInput), rowCount: text(countText) };
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('조회 조건이 변경되었습니다. 조회가 끝난 뒤 다시 실행해 주세요.');
  return { ...before, rows: [...rows.values()] };
}

/** Pure validator; exported so boundary cases can be checked without a browser. */
export function parsePortalSnapshot(snapshot, now = new Date()) {
  const fail = message => { throw new Error(message); };
  const clean = value => typeof value === 'string' ? value.replace(/[\u200b\ufeff]/g, '').replace(/\u00a0/g, ' ').trim() : '';
  if (!snapshot || !clean(snapshot.store) || !clean(snapshot.brand)) fail('점포·브랜드가 표시된 조회 결과가 필요합니다.');
  const month = /^(\d{4})(?:[-./]?(\d{2}))$/.exec(clean(snapshot.month));
  if (!month || Number(month[1]) < 2000 || Number(month[1]) > 2199 || Number(month[2]) < 1 || Number(month[2]) > 12) fail('조회 월을 YYYY-MM 형식으로 확인하지 못했습니다.');
  const year = Number(month[1]), monthNumber = Number(month[2]);
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const prefix = `${month[1]}-${month[2]}-`;
  const countMatch = /^총\s*([\d,]+)\s*건$/.exec(clean(snapshot.rowCount));
  const count = countMatch ? Number(countMatch[1].replace(/,/g, '')) : NaN;
  if (count !== days) fail(`총 조회 건수가 이 달의 ${days}일과 일치하지 않습니다. 월 전체를 조회해 주세요.`);
  if (!Array.isArray(snapshot.rows) || snapshot.rows.length !== count) fail(`표 일부만 화면에 준비되어 있습니다. ${days}일 전체 행이 표시되어야 복사할 수 있습니다.`);
  const todayParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const today = ['year', 'month', 'day'].map(type => todayParts.find(part => part.type === type)?.value).join('-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) fail('한국 기준 오늘 날짜를 확인하지 못했습니다.');
  const integer = (value, label) => {
    const input = clean(value).replace(/\u2212/g, '-');
    if (input === '-') return 0;
    if (!/^(?:-?(?:\d{1,3}(?:,\d{3})+|\d+)|\((?:\d{1,3}(?:,\d{3})+|\d+)\))$/.test(input)) fail(`${label} 셀을 숫자로 확인하지 못했습니다. 조회 완료 후 다시 실행해 주세요.`);
    const number = Number(input.replace(/,/g, '').replace(/^\((.*)\)$/, '-$1'));
    if (!Number.isSafeInteger(number)) fail(`${label} 값이 안전하게 읽을 수 있는 범위를 벗어났습니다.`);
    return number;
  };
  const byIndex = [...snapshot.rows].sort((a, b) => a.index - b.index);
  const seenDates = new Set(), parsed = [];
  const channels = ['department', 'online', 'mobile'];
  const groups = [
    { key: 'quantity', columns: [7, 8, 9], total: 10, label: '수량' },
    { key: 'gross', columns: [11, 12, 13], total: 14, label: '총매출' },
    { key: 'priorGross', columns: [15, 16, 17], total: 18, label: '전년 매출' },
    { key: 'net', columns: [23, 24, 25], total: 26, label: '순매출' }
  ];
  for (let index = 0; index < byIndex.length; index++) {
    const row = byIndex[index];
    if (!row || row.index !== index || !row.cells) fail('표 행 번호가 끊기거나 중복되었습니다. 월 전체가 표시되어야 합니다.');
    if (integer(row.cells[0], `${index + 1}행 순번`) !== index + 1) fail('표 순번과 행 위치가 일치하지 않습니다. 조회 완료 후 다시 실행해 주세요.');
    const match = /^(\d{4})[-./]?(\d{2})[-./]?(\d{2})$/.exec(clean(row.cells[1]));
    const date = match ? `${match[1]}-${match[2]}-${match[3]}` : '';
    const day = Number(match?.[3]);
    if (!date.startsWith(prefix) || day < 1 || day > days || seenDates.has(date)) fail('조회 월의 날짜가 중복되거나 빠져 있습니다. 다른 달의 자료는 복사하지 않았습니다.');
    seenDates.add(date);
    // Future placeholder rows are required for completeness, but never exported.
    if (date > today) continue;
    const result = { date, department: {}, online: {}, mobile: {} };
    for (const group of groups) {
      const values = group.columns.map(column => integer(row.cells[column], `${date} ${group.label}`));
      const total = integer(row.cells[group.total], `${date} ${group.label} 합계`);
      const sum = values.reduce((a, b) => a + b, 0);
      if (!Number.isSafeInteger(sum) || sum !== total) fail(`${date} ${group.label} 합계가 채널별 합과 다릅니다. 일부 셀만 읽힌 자료는 복사하지 않았습니다.`);
      channels.forEach((channel, position) => { result[channel][group.key] = values[position]; });
    }
    parsed.push(result);
  }
  for (let day = 1; day <= days; day++) if (!seenDates.has(prefix + String(day).padStart(2, '0'))) fail('조회 월의 날짜가 빠져 있습니다.');
  if (!parsed.length) fail('오늘까지의 조회 결과가 없습니다. 미래 월은 복사하지 않습니다.');
  parsed.sort((a, b) => a.date.localeCompare(b.date));
  return { schema: 1, store: clean(snapshot.store), brand: clean(snapshot.brand), source: '롯데백화점 파트너포털', rows: parsed };
}

/** Run only when the user activates the bookmark on their portal page. */
export function buildPortalBookmarklet() {
  const program = `(async()=>{
    const read=${readRenderedPortal.toString()};
    const parse=${parsePortalSnapshot.toString()};
    try {
      const payload=parse(read(document));
      const json=JSON.stringify(payload);
      if(navigator.clipboard?.writeText){
        try {await navigator.clipboard.writeText(json);alert('검증된 '+payload.rows.length+'일 자료를 복사했습니다. 판매량 분석기에 붙여넣어 주세요.');return;}catch{}
      }
      const field=document.createElement('textarea');
      const previous=document.activeElement;
      field.value=json;field.readOnly=true;field.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;opacity:0';
      document.body.appendChild(field);field.focus();field.select();
      let copied=false;try{copied=document.execCommand('copy');}catch{}finally{field.remove();previous?.focus?.({preventScroll:true});}
      if(copied){alert('검증된 '+payload.rows.length+'일 자료를 복사했습니다. 판매량 분석기에 붙여넣어 주세요.');}
      else{prompt('자동 복사가 허용되지 않았습니다. 아래 JSON 전체를 복사해 분석기에 붙여넣어 주세요.',json);}
    } catch(error) {alert('자료를 복사하지 않았습니다.\\n'+(error?.message||'조회 화면을 확인해 주세요.'));}
  })();`;
  return 'javascript:' + encodeURIComponent(program);
}
