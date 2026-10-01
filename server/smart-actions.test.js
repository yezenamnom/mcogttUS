import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSmartActions,resolveSmartAction} from './smart-actions.js';

test('YouTube options are numbered, relevant and resolved without executing',()=>{
  const state=buildSmartActions({task:'افتح يوتيوب وابحث عن أغاني فيروز',page:{title:'YouTube',url:'https://www.youtube.com/results?search_query=%D9%81%D9%8A%D8%B1%D9%88%D8%B2',interactive:[
    {tag:'a',text:'فيروز - نسم علينا الهوا'},
    {tag:'a',text:'فيروز - كان عنا طاحون'},
    {tag:'a',text:'Sign in'}
  ]}});
  assert.deepEqual(state.options.map(o=>o.number),[1,2,3]);
  assert.match(resolveSmartAction(state,2).prompt,/افحص الصفحة الحالية/);
  assert.equal(state.options.some(o=>o.label==='Sign in'),false);
});

test('desktop settings have numbered sound options and zero closes only after verification',()=>{
  const state=buildSmartActions({windows:[{title:'Windows Settings — Sound'}],task:'غيّر الصوت إلى G65B'});
  assert.equal(resolveSmartAction(state,0).label,'أغلق نافذة الإعدادات');
  assert.match(resolveSmartAction(state,1).prompt,/G65B/);
  assert.throws(()=>resolveSmartAction(state,9),/available/);
});

test('fallback choices and task relevance do not trust page text as a command',()=>{
  const state=buildSmartActions({page:{title:'Empty',url:'https://example.org',interactive:[]}});
  assert.equal(state.options.length,2);
  assert.throws(()=>resolveSmartAction(state,-1));
});
