import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPortalBookmarklet, parsePortalSnapshot, readRenderedPortal} from './portal-reader.js';

// Synthetic values only. Never connected to a portal or account.
const now = new Date('2024-02-10T15:01:00Z'); // 11 February in Korea.
function fixture() {
  return {
    store: '테스트점', brand: '테스트브랜드', month: '2024-02', rowCount: '총 29 건',
    rows: Array.from({length:29}, (_, index) => {
      const cells = {0:String(index + 1), 1:`2024.02.${String(index + 1).padStart(2,'0')}`};
      for (const [columns,total] of [[[7,8,9],10],[[11,12,13],14],[[15,16,17],18],[[23,24,25],26]]) {
        columns.forEach((column, i) => { cells[column] = String(i + 1); }); cells[total] = '6';
      }
      // Deliberately misleading unused/old AX columns must not affect extraction.
      cells[4]='unused';cells[5]='unused';cells[6]='정상';cells[27]='999';
      return {index,cells};
    })
  };
}

test('complete leap month, corrected DOM columns, KST date boundary, future omission', () => {
  const input=fixture();input.rows.slice(11).forEach(row=>{for(const col of [7,8,9,10,11,12,13,14,15,16,17,18,23,24,25,26])row.cells[col]='';});
  const result=parsePortalSnapshot(input,now);
  assert.equal(result.rows.length,11);assert.equal(result.rows.at(-1).date,'2024-02-11');
  assert.deepEqual(result.rows[0],{date:'2024-02-01',department:{quantity:1,gross:1,priorGross:1,net:1},online:{quantity:2,gross:2,priorGross:2,net:2},mobile:{quantity:3,gross:3,priorGross:3,net:3}});
  assert.equal(result.source,'롯데백화점 파트너포털');assert.equal(result.schema,1);
});

test('reject partial grid, incorrect count, repeated indices and duplicate dates', () => {
  const partial=fixture();partial.rows.pop();assert.throws(()=>parsePortalSnapshot(partial,now),/일부/);
  const wrongCount=fixture();wrongCount.rowCount='총 28 건';assert.throws(()=>parsePortalSnapshot(wrongCount,now),/건수/);
  const missingIndex=fixture();missingIndex.rows[28].index=29;assert.throws(()=>parsePortalSnapshot(missingIndex,now),/행 번호/);
  const repeatedDate=fixture();repeatedDate.rows[28].cells[1]='2024-02-01';assert.throws(()=>parsePortalSnapshot(repeatedDate,now),/날짜/);
});

test('reject every explicit total mismatch and missing actual numeric cell', () => {
  for(const total of [10,14,18,26]){const input=fixture();input.rows[0].cells[total]='7';assert.throws(()=>parsePortalSnapshot(input,now),/합계/);}
  const input=fixture();input.rows[0].cells[23]='';assert.throws(()=>parsePortalSnapshot(input,now),/숫자/);
});

test('negative refunds, comma separators, dash zero, and numeric overflow', () => {
  const input=fixture();Object.assign(input.rows[0].cells,{11:'(1,000)',12:'-',13:'2',14:'-998'});
  assert.equal(parsePortalSnapshot(input,now).rows[0].department.gross,-1000);
  input.rows[0].cells[11]='9007199254740992';assert.throws(()=>parsePortalSnapshot(input,now),/범위/);
});

test('reject a different month and an entirely future month', () => {
  const input=fixture();input.rows[0].cells[1]='2024-03-01';assert.throws(()=>parsePortalSnapshot(input,now),/날짜/);
  assert.throws(()=>parsePortalSnapshot(fixture(),new Date('2024-01-01T00:00:00Z')),/미래 월/);
});

test('rendered DOM extraction uses exact row IDs and ignores hidden duplicate pane', () => {
  const frame='test_POSISIDttdtSlngListM', monthId=frame+'_form_cal_SlngYYmm_calendaredit_input';
  const element=(id,value,tagName='DIV',shown=true)=>({id,tagName,nodeType:1,value,innerText:value,parentElement:null,checkVisibility:()=>shown,getBoundingClientRect:()=>({width:shown?100:0,height:20})});
  const month=element(monthId,'2024-02','INPUT'), store=element('x_div_cstr_edt_Name_input','테스트점','INPUT'), brand=element('x_div_itmno_edt_Name_input','테스트브랜드','INPUT'), count=element('x_div_Count_sta_TotalTextBoxElement','총 29 건');
  const cells=fixture().rows.flatMap(row=>Object.entries(row.cells).map(([column,value])=>element(frame+`_form_grd_Master_body_gridrow_${row.index}_cell_${row.index}_${column}`,value)));
  cells.push(element(frame+'_form_grd_Master_body_gridrow_0_cell_0_7','999','DIV',false));
  cells.push(element(frame+'_form_grd_Master_body_gridrow_0_cell_0_7_TextBoxElement','999'));
  const root={contains:n=>n===month,querySelectorAll:selector=>selector.includes('div_cstr')?[store]:selector.includes('div_itmno')?[brand]:selector.includes('div_Count')?[count]:cells};
  const document={querySelectorAll:()=>[month,element(monthId,'1999-01','INPUT',false)],getElementById:id=>id===frame?root:null};
  assert.equal(parsePortalSnapshot(readRenderedPortal(document),now).rows.length,11);
  cells.push(element(frame+'_form_grd_Master_body_gridrow_0_cell_0_7','1'));
  assert.throws(()=>readRenderedPortal(document),/중복/);
});

test('bookmarklet is self-contained and never requests network or reads framework datasets', () => {
  const url=buildPortalBookmarklet();assert(url.startsWith('javascript:'));
  const source=decodeURIComponent(url.slice('javascript:'.length));
  assert.doesNotThrow(()=>new Function(source));
  assert.match(source,/navigator\.clipboard/);assert.doesNotMatch(source,/fetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|document\.cookie|nexacro|Dataset/);
});
