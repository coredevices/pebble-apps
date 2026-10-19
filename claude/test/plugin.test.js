const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SOURCE = readFileSync(path.join(__dirname, '../src/plugin/index.js'), 'utf8');
const ORG='11111111-1111-4111-8111-111111111111', OTHER='22222222-2222-4222-8222-222222222222';
const CHAT='33333333-3333-4333-8333-333333333333', HUMAN='44444444-4444-4444-8444-444444444444', LEAF='55555555-5555-4555-8555-555555555555';
const CODE='cse_example123', BASE='/api/organizations/'+ORG, DETAIL=BASE+'/chat_conversations/'+CHAT+'?tree=True&rendering_mode=messages&render_all_tools=true';
const POST=BASE+'/chat_conversations/'+CHAT+'/completion', CDETAIL='/v1/code/sessions/'+CODE, CPOST=CDETAIL+'/events';
const chat=()=>({uuid:CHAT,name:'Planning',model:'claude-test-model',current_leaf_message_uuid:LEAF,chat_messages:[
  {uuid:HUMAN,sender:'human',text:'first',parent_message_uuid:'00000000-0000-4000-8000-000000000000'},
  {uuid:LEAF,sender:'assistant',content:[{type:'text',text:'reply'}],parent_message_uuid:HUMAN},
  {uuid:OTHER,sender:'assistant',text:'unselected branch',parent_message_uuid:HUMAN}]});
const json=(value,status=200)=>({status,json:async()=>value,text:async()=>JSON.stringify(value)});
function fixture(overrides={}) {
  const calls=[],storage=new Map();let action,config,source;
  const routes={
    'GET /api/organizations':()=>json([{uuid:ORG,name:'Personal'}]),
    ['GET '+BASE+'/chat_conversations?limit=100']:()=>json([chat()]),
    'GET /v1/code/sessions?limit=100':()=>json({data:[{id:CODE,title:'CoreApp'}],next_cursor:null}),
    ['GET '+DETAIL]:()=>json(chat()),
    ['GET '+CDETAIL]:()=>json({id:CODE,title:'CoreApp',status:'active',environment_kind:'bridge',connection_status:'connected'}),
    ['POST '+POST]:init=>({status:200,text:async()=> 'event: message_start\ndata: '+JSON.stringify({type:'message_start',message:{uuid:JSON.parse(init.body).turn_message_uuids.assistant_message_uuid}})+'\n\ndata: {"type":"message_stop"}\n\n'}),
    ['POST '+CPOST]:()=>json({results:[{event_id:'evt-1',sequence_num:'3',duplicate:false}]}),...overrides};
  const sandbox={Date,Uint8Array,Math,JSON,fetch:async(url,init)=>{
    assert.ok(url.startsWith('https://claude.ai/'));const key=init.method+' '+url.slice('https://claude.ai'.length);
    calls.push({key,init});assert.ok(routes[key],'unexpected '+key);return routes[key](init);
  },Pebble:{secureStorage:{getItem:async k=>storage.get(k),setItem:async(k,v)=>storage.set(k,v),removeItem:async k=>storage.delete(k)},
    registerActionHandler:fn=>action=fn,registerConfigHandler:fn=>config=fn,registerSourceHandler:fn=>source=fn}};
  vm.runInNewContext(SOURCE,sandbox);
  const configCall=m=>new Promise(resolve=>config(m,resolve));
  return {calls,storage,routes,sandbox,config:configCall,connect:()=>configCall({type:'connect',session_key:'secret-cookie'}),
    action:(name,args={})=>new Promise(resolve=>action({action:name,args},{ok:r=>resolve({ok:true,...r}),error:(code,message)=>resolve({code,message})})),
    source:()=>new Promise(resolve=>source({category:'messaging',item:'session'},{data:resolve,error:(code,message)=>resolve({code,message})}))};
}
const sendChat=f=>f.action('send_to_claude',{session_id:'chat:'+CHAT,message:'hello 世界'});
const sendCode=f=>f.action('send_to_claude',{session_id:'code:'+CODE,message:'run tests'});
const posts=f=>f.calls.filter(c=>c.key.startsWith('POST'));

test('sign-in verifies membership and only secure storage contains credentials',async()=>{
  const f=fixture();const r=await f.connect();assert.equal(r.organization,ORG);assert.ok(!JSON.stringify(r).includes('secret-cookie'));
  assert.equal(JSON.parse([...f.storage.values()][0]).cookie,'secret-cookie');assert.equal(f.calls[0].init.headers.Cookie,'sessionKey=secret-cookie');
  await f.config({type:'disconnect'});assert.equal(f.storage.size,0);assert.equal((await f.source()).instances[0].properties.configured.boolean.value,false);
});
test('multiple organizations require selection; switching clears default',async()=>{
  const f=fixture({'GET /api/organizations':()=>json([{uuid:ORG,name:'A'},{uuid:OTHER,name:'B'}])});assert.equal((await f.connect()).organization,null);
  assert.equal((await f.action('list_claude_sessions')).code,'INVALID_ARGS');assert.ok((await f.config({type:'organization',id:CHAT})).error);
  await f.config({type:'organization',id:ORG});await f.config({type:'select',session_id:'chat:'+CHAT});assert.equal((await f.config({type:'organization',id:OTHER})).selected,null);
});
test('malformed cookies are rejected before network access',async()=>{
  for(const cookie of ['',null,'secret; evil=yes','secret\r\nX: evil','a'.repeat(16385)]){
    const f=fixture();assert.ok((await f.config({type:'connect',session_key:cookie})).error);assert.equal(f.calls.length,0);
  }
});
test('list pages preserve cursors and distinguish chat from code',async()=>{
  const f=fixture();await f.connect();assert.equal(JSON.parse((await f.action('list_claude_sessions')).text).sessions[0].session_id,'chat:'+CHAT);
  f.routes['GET /v1/code/sessions?limit=100']=()=>json({data:[{id:CODE,title:'CoreApp'}],next_cursor:'next/page'});
  f.routes['GET /v1/code/sessions?limit=100&cursor=next%2Fpage']=()=>json({data:[],next_cursor:null});
  const b=JSON.parse((await f.action('list_claude_sessions',{kind:'code'})).text);assert.equal(b.next_cursor,'next/page');
  await f.action('list_claude_sessions',{kind:'code',cursor:b.next_cursor});const h=f.calls.at(-1).init.headers;
  assert.equal(h['x-organization-uuid'],ORG);assert.equal(h['anthropic-client-platform'],'web_claude_ai');assert.equal(h.Cookie,'sessionKey=secret-cookie; lastActiveOrg='+ORG);
});
test('supports paginated chat list envelopes',async()=>{
  const f=fixture({['GET '+BASE+'/chat_conversations?limit=100']:()=>json({conversations:[chat()],cursor:'next'})});await f.connect();
  assert.equal(JSON.parse((await f.action('list_claude_sessions')).text).next_cursor,'next');
});
test('chat send uses current branch and correlated UUIDs, not the last array message',async()=>{
  const f=fixture();await f.connect();await f.config({type:'select',session_id:'chat:'+CHAT});
  assert.equal((await f.source()).instances[0].properties.name.shortText.text,'Planning');
  const r=await f.action('send_to_claude',{message:'hello 世界'});assert.equal(r.ok,true);const b=JSON.parse(posts(f)[0].init.body);
  assert.equal(b.parent_message_uuid,LEAF);assert.equal(b.prompt,'hello 世界');assert.equal(b.turn_message_uuids.human_message_uuid,r.message_id);
  assert.notEqual(b.turn_message_uuids.human_message_uuid,b.turn_message_uuids.assistant_message_uuid);assert.equal(b.create_conversation_params,undefined);
  assert.equal(posts(f)[0].init.headers['Content-Type'],'application/json; charset=utf-8');
});
test('Code send uses wrapped stream-json events',async()=>{
  const f=fixture();await f.connect();const r=await sendCode(f);assert.equal(r.ok,true);const b=JSON.parse(posts(f)[0].init.body);
  assert.equal(b.session_id,CODE);assert.equal(b.events[0].payload.type,'user');assert.equal(b.events[0].payload.message.content[0].text,'run tests');assert.equal(b.events[0].payload.uuid,r.message_id);
});
test('offline and archived Code sessions cannot receive messages',async()=>{
  for(const extra of [{connection_status:'disconnected'},{status:'archived'}]){
    const f=fixture({['GET '+CDETAIL]:()=>json({id:CODE,environment_kind:'bridge',connection_status:'connected',...extra})});await f.connect();assert.ok(!(await sendCode(f)).ok);assert.equal(posts(f).length,0);
  }
});
test('chat read follows selected branch',async()=>{
  const f=fixture();await f.connect();const r=JSON.parse((await f.action('read_claude_session',{session_id:'chat:'+CHAT})).text);assert.deepEqual(r.messages.map(m=>m.text),['first','reply']);
});
test('Code read excludes thinking/tool content and restores chronological order',async()=>{
  const f=fixture({['GET '+CPOST+'?limit=100&sort_order=desc']:()=>json({data:[
    {payload:{type:'assistant',uuid:LEAF,message:{role:'assistant',content:[{type:'thinking',thinking:'private'},{type:'text',text:'done'}]}}},
    {payload:{type:'system'}},{payload:{type:'user',uuid:HUMAN,message:{role:'user',content:'hello'}}}]})});await f.connect();
  const r=JSON.parse((await f.action('read_claude_session',{session_id:'code:'+CODE})).text);assert.deepEqual(r.messages.map(m=>m.text),['hello','done']);
});
test('mismatched IDs, missing leaf and busy chat never produce a send',async()=>{
  for(const mutate of [c=>({...c,uuid:OTHER}),c=>({...c,current_leaf_message_uuid:HUMAN}),c=>({...c,is_streaming:true}),c=>({...c,current_leaf_message_uuid:null})]){
    const f=fixture({['GET '+DETAIL]:()=>json(mutate(chat()))});await f.connect();assert.ok(!(await sendChat(f)).ok);assert.equal(posts(f).length,0);
  }
});
test('cyclic branch fails closed',async()=>{
  const c=chat();c.chat_messages[0].parent_message_uuid=LEAF;const f=fixture({['GET '+DETAIL]:()=>json(c)});await f.connect();assert.ok(!(await sendChat(f)).ok);assert.equal(posts(f).length,0);
});
test('malformed success, 5xx and network failure report uncertainty without retry',async()=>{
  for(const handler of [()=>json({}),()=>json({},500),()=>{throw new Error('secret-cookie upstream');}]){
    const f=fixture({['POST '+CPOST]:handler});await f.connect();const r=await sendCode(f);assert.match(r.message,/uncertain/);assert.ok(!r.message.includes('secret-cookie'));assert.equal(posts(f).length,1);
  }
});
test('401, 403 and 429 remain distinct and do not retry sends',async()=>{
  for(const [status,code] of [[401,'AUTH_REQUIRED'],[403,'PERMISSION_DENIED'],[429,'RATE_LIMITED']]){
    const f=fixture({['POST '+CPOST]:()=>json({secret:'secret-cookie'},status)});await f.connect();assert.equal((await sendCode(f)).code,code);assert.equal(posts(f).length,1);
  }
});
test('HTML success is not delivery confirmation',async()=>{
  const f=fixture({['POST '+POST]:()=>({status:200,text:async()=>'<html>Sign in</html>'})});await f.connect();assert.match((await sendChat(f)).message,/uncertain/);assert.equal(posts(f).length,1);
});
test('persisted human UUID confirms delivery when SSE shape changes',async()=>{
  const f=fixture();await f.connect();f.routes['POST '+POST]=init=>{
    const id=JSON.parse(init.body).turn_message_uuids.human_message_uuid;
    f.routes['GET '+DETAIL]=()=>json({...chat(),chat_messages:[...chat().chat_messages,{uuid:id,sender:'human',text:'hello 世界'}]});return {status:200,text:async()=> 'data: {}\n\n'};
  };assert.equal((await sendChat(f)).ok,true);assert.equal(posts(f).length,1);
});
test('path injection, empty messages and oversized messages fail validation',async()=>{
  const f=fixture();await f.connect();for(const args of [{session_id:'code:../../secret',message:'x'},{session_id:'https://evil.test',message:'x'},{message:''},{message:'   '},{message:'x'.repeat(16001)}]){
    assert.equal((await f.action('send_to_claude',args)).code,'INVALID_ARGS');
  }assert.equal(posts(f).length,0);
});
test('overlapping sends issue only one POST',async()=>{
  const f=fixture();await f.connect();let release,started;const ready=new Promise(resolve=>started=resolve);
  f.routes['POST '+CPOST]=()=>new Promise(resolve=>{release=()=>resolve(json({results:[{event_id:'evt'}]}));started();});
  const first=sendCode(f);await ready;assert.equal((await sendCode(f)).code,'INVALID_ARGS');release();assert.equal((await first).ok,true);assert.equal(posts(f).length,1);
});

test('current Claude server-assigned UUIDs confirm a completed response stream',async()=>{
  const f=fixture({['POST '+POST]:()=>({status:200,text:async()=>
    'data: '+JSON.stringify({type:'message_start',message:{role:'assistant',uuid:OTHER,parent_uuid:HUMAN}})+'\n\ndata: {"type":"message_stop"}\n\n'})});
  await f.connect();const r=await sendChat(f);assert.equal(r.ok,true);assert.equal(r.message_id,HUMAN);assert.equal(posts(f).length,1);
});
test('truncated and error streams do not confirm server-assigned IDs',async()=>{
  for(const tail of ['', 'data: {"type":"error"}\n\ndata: {"type":"message_stop"}\n\n']){
    const f=fixture({['POST '+POST]:()=>({status:200,text:async()=>
      'data: '+JSON.stringify({type:'message_start',message:{role:'assistant',uuid:OTHER,parent_uuid:HUMAN}})+'\n\n'+tail})});
    await f.connect();assert.match((await sendChat(f)).message,/uncertain/);
  }
});

test('Code detail accepts the current response_shape wrapper and still checks identity',async()=>{
  const f=fixture({['GET '+CDETAIL]:()=>json({response_shape:{id:CODE,title:'Code',status:'active',environment_kind:'anthropic_cloud'}})});
  await f.connect();assert.equal((await sendCode(f)).ok,true);
  f.routes['GET '+CDETAIL]=()=>json({response_shape:{id:'cse_other'}});
  assert.ok(!(await sendCode(f)).ok);assert.equal(posts(f).length,1);
});

test('nicknames persist without changing the default and route case-insensitively',async()=>{
  const f=fixture();await f.connect();await f.config({type:'select',session_id:'chat:'+CHAT});
  const r=await f.config({type:'save_session',session_id:'code:'+CODE,nickname:' Work ',makeDefault:false});
  assert.equal(r.selected.session_id,'chat:'+CHAT);
  assert.equal((await f.action('send_to_claude',{chat:'wOrK',message:'hello'})).session_id,'code:'+CODE);
  assert.equal(JSON.parse((await f.action('list_claude_sessions',{kind:'code'})).text).sessions[0].nickname,'Work');
  await f.config({type:'save_session',session_id:'code:'+CODE,nickname:'Work',makeDefault:true});
  assert.equal((await f.action('send_to_claude',{message:'hello'})).session_id,'code:'+CODE);
  assert.equal((await f.source()).instances[0].properties.name.shortText.text,'Work');
});
test('nicknames move between sessions, can be cleared, and reject oversized names',async()=>{
  const f=fixture();await f.connect();
  await f.config({type:'save_session',session_id:'chat:'+CHAT,nickname:'Work'});
  await f.config({type:'save_session',session_id:'code:'+CODE,nickname:'work'});
  assert.equal((await f.config({type:'list',kind:'chat'})).sessions[0].nickname,'');
  assert.ok((await f.config({type:'save_session',session_id:'code:'+CODE,nickname:'a'.repeat(41)})).error);
  await f.config({type:'save_session',session_id:'code:'+CODE,nickname:''});
  assert.equal((await f.config({type:'list',kind:'code'})).sessions[0].nickname,'');
});
test('title routing searches both kinds and all pages; ambiguous matches never send',async()=>{
  const f=fixture();await f.connect();
  assert.equal((await f.action('send_to_claude',{chat:'planning',message:'hello'})).session_id,'chat:'+CHAT);
  f.routes['GET /v1/code/sessions?limit=100']=()=>json({data:[],next_cursor:'next'});
  f.routes['GET /v1/code/sessions?limit=100&cursor=next']=()=>json({data:[{id:CODE,title:'Planning too'}]});
  const before=posts(f).length;
  assert.equal((await f.action('send_to_claude',{chat:'planning',message:'hello'})).code,'INVALID_ARGS');
  assert.equal(posts(f).length,before);
  assert.equal((await f.action('send_to_claude',{chat:'Planning too',message:'hello'})).session_id,'code:'+CODE);
});
test('nickname ambiguity and conflicting destination arguments fail without sending',async()=>{
  const f=fixture();await f.connect();
  await f.config({type:'save_session',session_id:'chat:'+CHAT,nickname:'work one'});
  await f.config({type:'save_session',session_id:'code:'+CODE,nickname:'work two'});
  for(const args of [{chat:'work'},{chat:5},{chat:'work one',session_id:'chat:'+CHAT}]) {
    assert.equal((await f.action('send_to_claude',{...args,message:'hello'})).code,'INVALID_ARGS');
  }
  assert.equal(posts(f).length,0);
});
test('old connection state keeps sign-in and default; nicknames stay organization-scoped',async()=>{
  const f=fixture();await f.connect();await f.config({type:'select',session_id:'chat:'+CHAT});
  assert.equal((await f.action('send_to_claude',{message:'hello'})).ok,true);
  await f.config({type:'save_session',session_id:'chat:'+CHAT,nickname:'personal'});
  f.routes['GET /api/organizations']=()=>json([{uuid:ORG,name:'Personal'},{uuid:OTHER,name:'Work'}]);
  await f.config({type:'organization',id:OTHER});
  assert.equal(JSON.parse(f.storage.get('claude.connection.v1')).cookie,'secret-cookie');
  await f.config({type:'organization',id:ORG});
  assert.equal((await f.config({type:'list',kind:'chat'})).sessions[0].nickname,'personal');
});
test('409 reports conflict and does not retry a send',async()=>{
  const f=fixture({['POST '+POST]:()=>json({},409)});await f.connect();
  const r=await sendChat(f);assert.match(r.message,/conflict/i);assert.match(r.message,/do not automatically retry/i);assert.equal(posts(f).length,1);
});

test('generic send forwards status unchanged to saved default without listing or reading history',async()=>{
  const f=fixture();await f.connect();await f.config({type:'select',session_id:'code:'+CODE});f.calls.length=0;
  const r=await f.action('send_to_claude',{message:'status'});
  assert.equal(r.session_id,'code:'+CODE);
  assert.deepEqual(f.calls.map(c=>c.key),['GET '+CDETAIL,'POST '+CPOST]);
  assert.equal(JSON.parse(posts(f)[0].init.body).events[0].payload.message.content[0].text,'status');
});
test('named-chat action requires a destination and resolves an explicit nickname',async()=>{
  const f=fixture();await f.connect();await f.config({type:'save_session',session_id:'code:'+CODE,nickname:'work'});
  assert.equal((await f.action('send_to_named_claude_chat',{message:'status'})).code,'INVALID_ARGS');
  assert.equal((await f.action('send_to_named_claude_chat',{chat:'work',message:'status'})).session_id,'code:'+CODE);
});

test('Codex-style chat browser includes both destinations and marks the default',async()=>{
  const f=fixture();await f.connect();await f.config({type:'select',session_id:'code:'+CODE});
  const r=JSON.parse((await f.action('list_claude_chats')).text);
  assert.deepEqual(r.sessions.map(x=>x.kind),['chat','code']);
  assert.equal(r.sessions.find(x=>x.kind==='code').isDefault,true);
  assert.equal((await f.action('send_to_claude',{chat:'CoreApp',message:'status'})).session_id,'code:'+CODE);
});
