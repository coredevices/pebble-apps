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
const CREATE='POST '+BASE+'/chat_conversations', ROOT='00000000-0000-4000-8000-000000000000';
const completionStream=init=>({status:200,text:async()=> 'event: message_start\ndata: '+JSON.stringify({type:'message_start',message:{uuid:JSON.parse(init.body).turn_message_uuids.assistant_message_uuid}})+'\n\ndata: {"type":"message_stop"}\n\n'});
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
    ['POST '+POST]:completionStream,
    ['POST '+CPOST]:()=>json({results:[{event_id:'evt-1',sequence_num:'3',duplicate:false}]}),...overrides};
  const sandbox={Date,Uint8Array,Math,JSON,fetch:async(url,init)=>{
    assert.ok(url.startsWith('https://claude.ai/'));const key=init.method+' '+url.slice('https://claude.ai'.length);
    calls.push({key,init});const handler=routes[key]||(routes.fallback&&routes.fallback(key,init));assert.ok(handler,'unexpected '+key);return handler(init);
  },Pebble:{secureStorage:{getItem:async k=>storage.get(k),setItem:async(k,v)=>storage.set(k,v),removeItem:async k=>storage.delete(k)},
    registerActionHandler:fn=>action=fn,registerConfigHandler:fn=>config=fn,registerSourceHandler:fn=>source=fn}};
  vm.runInNewContext(SOURCE,sandbox);
  const configCall=m=>new Promise(resolve=>config(m,resolve));
  return {calls,storage,routes,sandbox,config:configCall,connect:()=>configCall({type:'connect',session_key:'secret-cookie'}),
    action:(name,args={})=>new Promise(resolve=>action({action:name,args},{ok:r=>resolve({ok:true,...r}),error:(code,message)=>resolve({code,message})})),
    source:(item='configured')=>new Promise(resolve=>source({category:'agent',item},{data:resolve,error:(code,message)=>resolve({code,message})}))};
}
const sendChat=f=>f.action('send_to_agent',{chat_id:'chat:'+CHAT,message:'hello 世界'});
const useDefault=f=>f.config({type:'mode',mode:'default_chat'});
// Routes for a conversation the plugin creates itself: its id is only known from the create body.
function newChatRoutes(f){
  f.routes[CREATE]=init=>json({uuid:JSON.parse(init.body).uuid,name:''});
  f.routes.fallback=(key,init)=>key.startsWith('POST '+BASE+'/chat_conversations/')&&key.endsWith('/completion')?completionStream:null;
}
const sendCode=f=>f.action('send_to_agent',{chat_id:'code:'+CODE,message:'run tests'});
const posts=f=>f.calls.filter(c=>c.key.startsWith('POST'));

test('sign-in verifies membership and only secure storage contains credentials',async()=>{
  const f=fixture();const r=await f.connect();assert.equal(r.organization,ORG);assert.ok(!JSON.stringify(r).includes('secret-cookie'));
  assert.equal(JSON.parse([...f.storage.values()][0]).cookie,'secret-cookie');assert.equal(f.calls[0].init.headers.Cookie,'sessionKey=secret-cookie');
  await f.config({type:'disconnect'});assert.equal(f.storage.size,0);assert.equal((await f.source()).instances[0].properties.configured.boolean.value,false);
});
test('multiple organizations require selection; switching clears default',async()=>{
  const f=fixture({'GET /api/organizations':()=>json([{uuid:ORG,name:'A'},{uuid:OTHER,name:'B'}])});assert.equal((await f.connect()).organization,null);
  assert.equal((await f.source('chats')).code,'INVALID_ARGS');assert.ok((await f.config({type:'organization',id:CHAT})).error);
  await f.config({type:'organization',id:ORG});await f.config({type:'select',session_id:'chat:'+CHAT});assert.equal((await f.config({type:'organization',id:OTHER})).selected,null);
});
test('malformed cookies are rejected before network access',async()=>{
  for(const cookie of ['',null,'secret; evil=yes','secret\r\nX: evil','a'.repeat(16385)]){
    const f=fixture();assert.ok((await f.config({type:'connect',session_key:cookie})).error);assert.equal(f.calls.length,0);
  }
});
test('list pages preserve cursors and distinguish chat from code',async()=>{
  const f=fixture();await f.connect();assert.equal((await f.config({type:'list'})).sessions[0].session_id,'chat:'+CHAT);
  f.routes['GET /v1/code/sessions?limit=100']=()=>json({data:[{id:CODE,title:'CoreApp'}],next_cursor:'next/page'});
  f.routes['GET /v1/code/sessions?limit=100&cursor=next%2Fpage']=()=>json({data:[],next_cursor:null});
  const b=await f.config({type:'list',kind:'code'});assert.equal(b.next_cursor,'next/page');
  await f.config({type:'list',kind:'code',cursor:b.next_cursor});const h=f.calls.at(-1).init.headers;
  assert.equal(h['x-organization-uuid'],ORG);assert.equal(h['anthropic-client-platform'],'web_claude_ai');assert.equal(h.Cookie,'sessionKey=secret-cookie; lastActiveOrg='+ORG);
});
test('supports paginated chat list envelopes',async()=>{
  const f=fixture({['GET '+BASE+'/chat_conversations?limit=100']:()=>json({conversations:[chat()],cursor:'next'})});await f.connect();
  assert.equal((await f.config({type:'list'})).next_cursor,'next');
});
test('chat send uses current branch and correlated UUIDs, not the last array message',async()=>{
  const f=fixture();await f.connect();await useDefault(f);await f.config({type:'select',session_id:'chat:'+CHAT});
  assert.equal((await f.source()).instances[0].properties.name.shortText.text,'Planning');
  const r=await f.action('send_to_agent',{message:'hello 世界'});assert.equal(r.ok,true);const b=JSON.parse(posts(f)[0].init.body);
  assert.equal(b.parent_message_uuid,LEAF);assert.equal(b.prompt,'hello 世界 ⌚');assert.equal(b.turn_message_uuids.human_message_uuid,r.message_id);
  assert.notEqual(b.turn_message_uuids.human_message_uuid,b.turn_message_uuids.assistant_message_uuid);assert.equal(b.create_conversation_params,undefined);
  assert.equal(posts(f)[0].init.headers['Content-Type'],'application/json; charset=utf-8');
});
test('Code send uses wrapped stream-json events',async()=>{
  const f=fixture();await f.connect();const r=await sendCode(f);assert.equal(r.ok,true);const b=JSON.parse(posts(f)[0].init.body);
  assert.equal(b.session_id,CODE);assert.equal(b.events[0].payload.type,'user');assert.equal(b.events[0].payload.message.content[0].text,'run tests ⌚');assert.equal(b.events[0].payload.uuid,r.message_id);
});
test('offline and archived Code sessions cannot receive messages',async()=>{
  for(const extra of [{connection_status:'disconnected'},{status:'archived'}]){
    const f=fixture({['GET '+CDETAIL]:()=>json({id:CODE,environment_kind:'bridge',connection_status:'connected',...extra})});await f.connect();assert.ok(!(await sendCode(f)).ok);assert.equal(posts(f).length,0);
  }
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
  const f=fixture();await f.connect();for(const args of [{chat_id:'code:../../secret',message:'x'},{chat_id:'chat:https://evil.test',message:'x'},{message:''},{message:'   '},{message:'x'.repeat(16001)}]){
    assert.equal((await f.action('send_to_agent',args)).code,'INVALID_ARGS');
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
  const f=fixture();await f.connect();await useDefault(f);await f.config({type:'select',session_id:'chat:'+CHAT});
  const r=await f.config({type:'save_session',session_id:'code:'+CODE,nickname:' Work ',makeDefault:false});
  assert.equal(r.selected.session_id,'chat:'+CHAT);
  assert.equal((await f.action('send_to_agent',{chat_id:'wOrK',message:'hello'})).session_id,'code:'+CODE);
  assert.equal((await f.config({type:'list',kind:'code'})).sessions[0].nickname,'Work');
  await f.config({type:'save_session',session_id:'code:'+CODE,nickname:'Work',makeDefault:true});
  assert.equal((await f.action('send_to_agent',{message:'hello'})).session_id,'code:'+CODE);
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
  assert.equal((await f.action('send_to_agent',{chat_id:'planning',message:'hello'})).session_id,'chat:'+CHAT);
  f.routes['GET /v1/code/sessions?limit=100']=()=>json({data:[],next_cursor:'next'});
  f.routes['GET /v1/code/sessions?limit=100&cursor=next']=()=>json({data:[{id:CODE,title:'Planning too'}]});
  const before=posts(f).length;
  assert.equal((await f.action('send_to_agent',{chat_id:'planning',message:'hello'})).code,'INVALID_ARGS');
  assert.equal(posts(f).length,before);
  assert.equal((await f.action('send_to_agent',{chat_id:'Planning too',message:'hello'})).session_id,'code:'+CODE);
});
test('nickname ambiguity and malformed destinations fail without sending',async()=>{
  const f=fixture();await f.connect();
  await f.config({type:'save_session',session_id:'chat:'+CHAT,nickname:'work one'});
  await f.config({type:'save_session',session_id:'code:'+CODE,nickname:'work two'});
  for(const args of [{chat_id:'work'},{chat_id:5}]) {
    assert.equal((await f.action('send_to_agent',{...args,message:'hello'})).code,'INVALID_ARGS');
  }
  assert.equal(posts(f).length,0);
});
test('old connection state keeps sign-in and default; nicknames stay organization-scoped',async()=>{
  const f=fixture();await f.connect();await useDefault(f);await f.config({type:'select',session_id:'chat:'+CHAT});
  assert.equal((await f.action('send_to_agent',{message:'hello'})).ok,true);
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
  const f=fixture();await f.connect();await useDefault(f);await f.config({type:'select',session_id:'code:'+CODE});f.calls.length=0;
  const r=await f.action('send_to_agent',{message:'status'});
  assert.equal(r.session_id,'code:'+CODE);
  assert.deepEqual(f.calls.map(c=>c.key),['GET '+CDETAIL,'POST '+CPOST]);
  assert.equal(JSON.parse(posts(f)[0].init.body).events[0].payload.message.content[0].text,'status ⌚');
});
test('unknown actions are rejected before touching the network',async()=>{
  const f=fixture();await f.connect();f.calls.length=0;
  for(const name of ['send_to_claude','list_claude_chats','read_claude_session']){
    assert.equal((await f.action(name,{message:'hello'})).code,'INVALID_ARGS');
  }
  assert.equal(f.calls.length,0);
});
test('chats source lists both kinds with the nickname as name and the chat id as instanceId',async()=>{
  const f=fixture();await f.connect();await f.config({type:'save_session',session_id:'code:'+CODE,nickname:'work'});
  const r=await f.source('chats');
  assert.deepEqual(Array.from(r.instances,i=>i.instanceId),['chat:'+CHAT,'code:'+CODE]);
  assert.deepEqual(Array.from(r.instances,i=>i.properties.name.shortText.text),['Planning','work']);
  assert.deepEqual(Array.from(r.instances,i=>i.properties.title.shortText.text),['Planning','CoreApp']);
  assert.equal(r.instances[1].properties.url.longText.text,'https://claude.ai/code/'+CODE);
  assert.equal((await f.action('send_to_agent',{chat_id:r.instances[1].instanceId,message:'status'})).session_id,'code:'+CODE);
});
test('chats source needs sign-in and an organization; configured depends on the mode',async()=>{
  const f=fixture();assert.equal((await f.source('chats')).code,'AUTH_REQUIRED');
  assert.equal((await f.source()).instances[0].properties.configured.boolean.value,false);
  await f.connect();
  let c=(await f.source()).instances[0].properties;assert.equal(c.configured.boolean.value,true);assert.equal(c.name.shortText.text,'New chat');
  await useDefault(f);assert.equal((await f.source()).instances[0].properties.configured.boolean.value,false);
  await f.config({type:'select',session_id:'code:'+CODE});
  c=(await f.source()).instances[0].properties;assert.equal(c.configured.boolean.value,true);assert.equal(c.name.shortText.text,'CoreApp');
  assert.equal((await f.source('other')).code,'INVALID_ARGS');
});
test('new-chat mode needs an organization before it reads as configured',async()=>{
  const f=fixture({'GET /api/organizations':()=>json([{uuid:ORG,name:'A'},{uuid:OTHER,name:'B'}])});await f.connect();
  assert.equal((await f.source()).instances[0].properties.configured.boolean.value,false);
  await f.config({type:'organization',id:ORG});
  assert.equal((await f.source()).instances[0].properties.configured.boolean.value,true);
});
test('with no chat named a message starts a new conversation under the root message',async()=>{
  const f=fixture();await f.connect();newChatRoutes(f);f.calls.length=0;
  const r=await f.action('send_to_agent',{message:'hello 世界'});
  assert.equal(r.ok,true);assert.match(r.text,/new chat/);
  const create=f.calls.find(c=>c.key===CREATE),created=JSON.parse(create.init.body);
  assert.equal(created.name,'');assert.equal(r.session_id,'chat:'+created.uuid);assert.equal(r.url,'https://claude.ai/chat/'+created.uuid);
  const completion=JSON.parse(posts(f)[1].init.body);
  assert.equal(posts(f)[1].key,'POST '+BASE+'/chat_conversations/'+created.uuid+'/completion');
  assert.equal(completion.parent_message_uuid,ROOT);assert.equal(completion.prompt,'hello 世界 ⌚');
  assert.deepEqual(f.calls.map(c=>c.key.split(' ')[0]),['POST','POST']);
});
test('a null chat_id means no chat was named',async()=>{
  const f=fixture();await f.connect();newChatRoutes(f);
  const r=await f.action('send_to_agent',{chat_id:null,message:'hello'});
  assert.equal(r.ok,true);assert.ok(f.calls.some(c=>c.key===CREATE));
  await useDefault(f);await f.config({type:'select',session_id:'code:'+CODE});
  assert.equal((await f.action('send_to_agent',{chat_id:null,message:'status'})).session_id,'code:'+CODE);
});
test('a chat the server did not create sends nothing and is not reported as uncertain',async()=>{
  for(const handler of [()=>json({uuid:OTHER}),()=>json({},500),()=>{throw new Error('down');}]){
    const f=fixture();await f.connect();f.routes[CREATE]=handler;
    const r=await f.action('send_to_agent',{message:'hello'});
    assert.equal(r.code,'PLUGIN_UNAVAILABLE');assert.doesNotMatch(r.message,/uncertain/);assert.equal(posts(f).length,1);
  }
});
test('a named chat still goes to that chat in new-chat mode, and the mode persists',async()=>{
  const f=fixture();await f.connect();await f.config({type:'save_session',session_id:'code:'+CODE,nickname:'work'});
  assert.equal((await f.action('send_to_agent',{chat_id:'work',message:'status'})).session_id,'code:'+CODE);
  assert.equal((await f.config({type:'status'})).mode,'new_chat');
  assert.ok((await f.config({type:'mode',mode:'sideways'})).error);
  assert.equal((await useDefault(f)).mode,'default_chat');
  assert.equal(JSON.parse(f.storage.get('claude.connection.v1')).mode,'default_chat');
  assert.equal((await f.action('send_to_agent',{message:'status'})).code,'INVALID_ARGS');
});

const configured=async f=>(await f.source()).instances[0].properties;
const legacy=(f,extra)=>f.storage.set('claude.connection.v1',JSON.stringify({cookie:'secret-cookie',organizations:[{id:ORG,name:'Personal'}],org:ORG,...extra}));
test('Claude Code never starts a new session: with no default it fails without sending',async()=>{
  const f=fixture();await f.connect();newChatRoutes(f);
  const s=await f.config({type:'kind',kind:'code'});assert.equal(s.kind,'code');assert.equal(s.mode,'default_chat');
  assert.equal((await f.config({type:'mode',mode:'new_chat'})).mode,'default_chat');
  assert.match((await f.action('send_to_agent',{message:'hello'})).message,/Claude Code session/);assert.equal(f.calls.filter(c=>c.key.startsWith('POST')).length,0);
  const c=await configured(f);assert.equal(c.configured.boolean.value,false);assert.match(c.configured.shortText.text,/Claude Code session/);
  assert.ok((await f.config({type:'kind',kind:'cursor'})).error);
});
test('each kind only uses a default of its own kind',async()=>{
  const f=fixture();await f.connect();await useDefault(f);await f.config({type:'select',session_id:'chat:'+CHAT});
  assert.equal((await f.config({type:'kind',kind:'code'})).selected,null);
  assert.equal((await configured(f)).configured.boolean.value,false);
  assert.equal((await f.action('send_to_agent',{message:'hello'})).code,'INVALID_ARGS');assert.equal(posts(f).length,0);
  assert.equal((await f.config({type:'list',kind:'chat'})).sessions[0].isDefault,false);
  const s=await f.config({type:'select',session_id:'code:'+CODE});assert.equal(s.kind,'code');assert.equal(s.selected.session_id,'code:'+CODE);
  let c=await configured(f);assert.equal(c.configured.boolean.value,true);assert.equal(c.name.shortText.text,'CoreApp');
  assert.equal((await f.action('send_to_agent',{message:'status'})).session_id,'code:'+CODE);
  // Back to Claude in new-chat mode: no default needed, and a named Code chat still routes there.
  await f.config({type:'kind',kind:'claude'});await f.config({type:'mode',mode:'new_chat'});
  c=await configured(f);assert.equal(c.configured.boolean.value,true);assert.equal(c.name.shortText.text,'New chat');
  assert.equal((await f.action('send_to_agent',{chat_id:'code:'+CODE,message:'status'})).session_id,'code:'+CODE);
  await f.config({type:'mode',mode:'default_chat'});assert.equal((await configured(f)).configured.boolean.value,false);
});
test('state saved before kinds existed infers the kind and keeps the mode',async()=>{
  let f=fixture();legacy(f,{mode:'default_chat',selected:{session_id:'code:'+CODE,title:'CoreApp'}});
  let s=await f.config({type:'status'});assert.equal(s.kind,'code');assert.equal(s.selected.session_id,'code:'+CODE);
  assert.equal((await f.action('send_to_agent',{message:'status'})).session_id,'code:'+CODE);
  f=fixture();legacy(f,{mode:'default_chat',selected:{session_id:'chat:'+CHAT,title:'Planning'}});
  s=await f.config({type:'status'});assert.equal(s.kind,'claude');assert.equal(s.mode,'default_chat');assert.equal((await configured(f)).name.shortText.text,'Planning');
  // New-chat mode with a Code default kept starting new Claude chats, and still does.
  f=fixture();legacy(f,{selected:{session_id:'code:'+CODE,title:'CoreApp'}});newChatRoutes(f);
  s=await f.config({type:'status'});assert.equal(s.kind,'claude');assert.equal(s.mode,'new_chat');
  assert.match((await f.action('send_to_agent',{message:'hello'})).text,/new chat/);
});
test('chat_id "new" always starts a new Claude chat, whatever the kind and mode',async()=>{
  const f=fixture();await f.connect();newChatRoutes(f);
  await f.config({type:'select',session_id:'code:'+CODE});await useDefault(f);
  for(const chat_id of ['new','New Chat','  NEW ']){
    f.calls.length=0;const r=await f.action('send_to_agent',{chat_id,message:'hello'});
    assert.match(r.text,/new chat/);assert.ok(r.session_id.startsWith('chat:'));assert.ok(f.calls.some(c=>c.key===CREATE));
    assert.ok(!f.calls.some(c=>c.key.startsWith('GET')));
  }
  await f.config({type:'kind',kind:'claude'});
  assert.match((await f.action('send_to_agent',{chat_id:'new',message:'hello'})).text,/new chat/);
  assert.equal((await f.action('send_to_agent',{chat_id:'newsletter',message:'hello'})).code,'INVALID_ARGS');
});
test('"new" and "new chat" are reserved and cannot be nicknames',async()=>{
  const f=fixture();await f.connect();
  for(const nickname of ['new','New Chat']) assert.match((await f.config({type:'save_session',session_id:'chat:'+CHAT,nickname})).error,/reserved/);
  assert.equal((await f.config({type:'list',kind:'chat'})).sessions[0].nickname,'');
  assert.equal((await f.config({type:'save_session',session_id:'chat:'+CHAT,nickname:'newsletter'})).error,undefined);
});
test('choosing a default of a different kind than the page shows is rejected and changes nothing',async()=>{
  const f=fixture();await f.connect();await useDefault(f);f.calls.length=0;
  assert.match((await f.config({type:'select',session_id:'code:'+CODE,kind:'claude'})).error,/Claude chat/);
  assert.match((await f.config({type:'select',session_id:'chat:'+CHAT,kind:'code'})).error,/Claude Code session/);
  assert.equal(f.calls.length,0);
  const s=await f.config({type:'status'});assert.equal(s.kind,'claude');assert.equal(s.selected,null);
  assert.equal((await f.config({type:'select',session_id:'chat:'+CHAT,kind:'claude'})).selected.session_id,'chat:'+CHAT);
});
const memory=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};};
const permissions=states=>({query:async key=>states[key]??'granted'});
test('reach: with Pebble.permissions, a domain not granted is named for sure, without any request',async()=>{
  const s=fixture().sandbox,request=()=>{throw new Error('no request expected');};
  assert.equal(await s.blockedHost(request,permissions({})),null);
  assert.deepEqual({...await s.blockedHost(request,permissions({'Internet/claude.ai':'denied'}))},{host:'claude.ai',sure:true});
  assert.deepEqual({...await s.blockedHost(request,permissions({'Internet/claude.ai':'prompt'}))},{host:'claude.ai',sure:true});
  s.HOSTS.push('second.example');
  try { assert.equal((await s.blockedHost(request,permissions({'Internet/second.example':'denied'}))).host,'second.example'); }
  finally { s.HOSTS.pop(); }
  assert.equal(s.blockedMessage({host:'claude.ai',sure:true}),'Claude doesn\'t have permission to connect to claude.ai. Turn on "Connect to claude.ai" in Claude\'s Permissions.');
});
test('reach: without it, first failure wins as a guess, a stalled probe does not block, the last check is remembered',async()=>{
  const f=fixture(),s=f.sandbox;s.localStorage=memory();
  assert.equal(await s.blockedHost(async()=>({status:403}),null),null);
  assert.deepEqual({...await s.blockedHost(()=>Promise.reject(new TypeError('blocked')),null)},{host:'claude.ai',sure:false});
  s.HOSTS.push('stalled.example');s.PROBES['stalled.example']='https://stalled.example/';
  try { assert.equal((await s.blockedHost(url=>url.includes('stalled')?new Promise(()=>{}):Promise.reject(new TypeError('blocked')),null)).host,'claude.ai'); }
  finally { s.HOSTS.pop(); }
  await s.checkReach(s.localStorage,()=>Promise.reject(new TypeError('blocked')));assert.deepEqual({...s.lastBlocked(s.localStorage)},{host:'claude.ai',sure:false});
  await s.checkReach(s.localStorage,async()=>({status:200}));assert.equal(s.lastBlocked(s.localStorage),null);
  s.localStorage.setItem('claude.blocked.v1','claude.ai');assert.equal(s.lastBlocked(s.localStorage),null);
});
test('reach: an unreachable send names the blocked domain and keeps the uncertainty warning',async()=>{
  const f=fixture({['POST '+CPOST]:()=>{throw new TypeError('fetch failed');}});f.sandbox.localStorage=memory();f.sandbox.localStorage.setItem('claude.blocked.v1',JSON.stringify({host:'claude.ai',sure:false}));
  await f.connect();const r=await sendCode(f);
  assert.match(r.message,/^Claude doesn't have permission to connect to claude\.ai\. Turn on "Connect to claude\.ai" in Claude's Permissions, or check your internet connection\. Delivery is uncertain/);
  f.sandbox.fetch=async()=>({status:200});assert.equal((await f.config({type:'reach'})).blocked,null);assert.equal(f.sandbox.localStorage.getItem('claude.blocked.v1'),null);
});
test('reach: a send the host refuses as not allowed names the domain for sure, with no cached check',async()=>{
  const f=fixture({['POST '+CPOST]:()=>{throw Object.assign(new Error('fetch not allowed: https://claude.ai'+CPOST),{name:'NotAllowedError'});}});f.sandbox.localStorage=memory();
  await f.connect();f.sandbox.Pebble.permissions=permissions({'Internet/claude.ai':'denied'});const r=await sendCode(f);
  assert.match(r.message,/^Claude doesn't have permission to connect to claude\.ai\. Turn on "Connect to claude\.ai" in Claude's Permissions\. Delivery is uncertain/);
  const reply=await f.config({type:'reach'});assert.deepEqual({...reply.blocked},{host:'claude.ai',sure:true});
});
