import test from 'node:test';
import assert from 'node:assert/strict';
import {imageResult} from './image-results.js';
test('batch screenshots and nested crop evidence become image blocks',()=>{
 const result=imageResult({results:[{ok:true,result:{data:'QUJD',mimeType:'image/png',width:2560}},{ok:true,result:{evidence:{crop:{data:'REVG',mimeType:'image/png',width:100}}}}]});
 assert.deepEqual(result.content.map(c=>c.type),['image','image','text']);
 assert.equal(result.content[0].data,'QUJD');
 const meta=JSON.parse(result.content[2].text);
 assert.equal(meta.results[0].result.width,2560);
 assert.equal(meta.results[1].result.evidence.crop.imageContentIndex,1);
 assert.ok(!result.content[2].text.includes('QUJD'));
});
test('ordinary command results and non-image file data remain intact',()=>{
 const input={completed:true,results:[{ok:false,error:'offline'},{data:'QUJD',mimeType:'application/pdf'}]};
 assert.deepEqual(JSON.parse(imageResult(input).content[0].text),input);
});
