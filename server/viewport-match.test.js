import {test} from 'node:test';
import assert from 'node:assert/strict';
import {locateViewport} from './viewport-match.js';
function fixture(){
 const page={width:260,height:260,data:Buffer.alloc(260*260*3)};
 let seed=42;for(let i=0;i<page.data.length;i++){seed=(seed*1664525+1013904223)>>>0;page.data[i]=seed>>>24;}
 const desktop={width:600,height:400,data:Buffer.alloc(600*400*3)};
 return {page,desktop};
}
function paste(d,p,x,y){for(let row=0;row<p.height;row++)p.data.copy(d.data,((row+y)*d.width+x)*3,row*p.width*3,(row+1)*p.width*3);}
test('locates distinctive viewport exactly',()=>{const {page,desktop}=fixture();paste(desktop,page,310,70);assert.deepEqual(locateViewport(desktop,page),{x:310,y:70,landmarks:24});});
test('rejects absent viewport',()=>{const {page,desktop}=fixture();assert.throws(()=>locateViewport(desktop,page),/not found/);});
test('rejects ambiguous duplicate views',()=>{const {page,desktop}=fixture();paste(desktop,page,0,20);paste(desktop,page,300,20);assert.throws(()=>locateViewport(desktop,page),/Ambiguous/);});
test('rejects plain pages without sufficient landmarks',()=>{const {page,desktop}=fixture();page.data.fill(0);assert.throws(()=>locateViewport(desktop,page),/Insufficient/);});
