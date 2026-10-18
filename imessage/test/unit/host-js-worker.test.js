'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {HostJsWorker} = require('../../src/runtime/host-js-worker');
function fixture() {
  const globalObject = {}, callbacks = new Map(), sent = [], closed = [];
  let nextTimer=0;
  const timer = {after(_,fn){callbacks.set(++nextTimer,fn);return nextTimer},cancel(id){callbacks.delete(id)}};
  const native = {open(){return 1},send(id,message){sent.push(JSON.parse(message))},close(id){closed.push(id)}};
  const worker = new HostJsWorker(native,timer,globalObject).open('source');
  return {worker,callbacks,sent,closed,reply:raw=>globalObject.__hostJsWorkerDispatch(1,raw)};
}
test('worker replies are correlated and timers are removed', async()=>{
  const f=fixture(), pending=f.worker.request('init',{});
  f.reply(JSON.stringify({id:f.sent[0].id,ok:true,result:'ready'}));
  assert.equal(await pending,'ready');assert.equal(f.callbacks.size,0);
  f.worker.close();f.worker.close();assert.deepEqual(f.closed,[1]);
});
test('worker termination rejects pending work and prevents reuse', async()=>{
  const f=fixture(),pending=f.worker.request('init',{});
  f.reply(null);await assert.rejects(pending);
  await assert.rejects(f.worker.request('init',{}));
  assert.equal(f.callbacks.size,0);assert.deepEqual(f.closed,[1]);
});
test('worker timeout closes the native worker',async()=>{
  const f=fixture(),pending=f.worker.request('sign',{});
  [...f.callbacks.values()][0]();
  await assert.rejects(pending);assert.deepEqual(f.closed,[1]);
});
test('worker rejects simultaneous requests without losing the first reply',async()=>{
  const f=fixture(),first=f.worker.request('init',{});
  await assert.rejects(f.worker.request('sign',{}));
  f.reply(JSON.stringify({id:f.sent[0].id,ok:true,result:true}));
  assert.equal(await first,true);f.worker.close();
});
test('worker fails closed on malformed or unrelated replies',async()=>{
  for(const reply of ['{',JSON.stringify({id:99,ok:true})]) {
    const f=fixture(),pending=f.worker.request('init',{});
    f.reply(reply);await assert.rejects(pending);assert.deepEqual(f.closed,[1]);
  }
});
test('worker startup failure before the first request is remembered',async()=>{
  const f=fixture();f.reply(null);
  await assert.rejects(f.worker.request('init',{}));assert.deepEqual(f.closed,[1]);
});
