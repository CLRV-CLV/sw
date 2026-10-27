import{test}from'node:test';import assert from'node:assert/strict';import{spawn}from'node:child_process';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{once}from'node:events';import WebSocket from'ws';
test('private websocket delivery, outsider isolation, revoked-session isolation and persistence',async()=>{
 const dir=mkdtempSync(tmpdir()+'/ik-dm-'),base='http://127.0.0.1:39127';let child;const sockets=[];
 async function start(){child=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,PORT:'39127',DATA_DIR:dir},stdio:'ignore'});for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,30));}throw Error('startup');}
 async function stop(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
 async function call(path,method='GET',body,token){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});return[r.status,await r.json()];}
 async function connect(token){const ws=new WebSocket('ws://127.0.0.1:39127/v1/realtime',{headers:token?{Authorization:`Bearer ${token}`}:{}});sockets.push(ws);ws.events=[];ws.on('message',d=>ws.events.push(JSON.parse(d)));await once(ws,'open');return ws;}
 try{
 await start();const users=[];for(const username of ['alice','bob','eve']){await call('/v1/auth/register','POST',{username,password:'test-password-123'});users.push((await call('/v1/auth/login','POST',{username,password:'test-password-123'}))[1]);}
 const[a,b,e]=users,wa=await connect(a.token),wb=await connect(b.token),we=await connect(e.token),guest=await connect();
 const conv=(await call('/v1/dm/direct','POST',{userId:b.user.id},a.token))[1];
 assert.equal((await call(`/v1/inbox/dm-${conv.id}/items`,'GET',undefined,e.token))[0],403);
 const sent=(await call(`/v1/dm/conversations/${conv.id}/messages`,'POST',{content:'private hello',clientId:'once'},a.token))[1];
 await new Promise(r=>setTimeout(r,100));
 assert.ok(wb.events.some(f=>f.t==='dm.message.created'&&f.d.message.id===sent.id));assert.ok(wa.events.some(f=>f.t==='dm.message.created'));
 assert.equal(we.events.some(f=>f.t?.startsWith('dm.')),false);assert.equal(guest.events.some(f=>f.t?.startsWith('dm.')),false);
 await call('/v1/auth/logout','POST',{},a.token);wa.events=[];
 await call(`/v1/dm/conversations/${conv.id}/messages`,'POST',{content:'after logout',clientId:'second'},b.token);
 await new Promise(r=>setTimeout(r,100));assert.equal(wa.events.some(f=>f.t?.startsWith('dm.')),false);
 for(const ws of sockets)ws.terminate();await stop();await start();
 const history=(await call(`/v1/inbox/dm-${conv.id}/items`,'GET',undefined,b.token))[1];assert.equal(history.items.length,2);assert.equal(history.items[1].message.content,'private hello');
 }finally{for(const ws of sockets)ws.terminate();await stop();rmSync(dir,{recursive:true,force:true});}
});
