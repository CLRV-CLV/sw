import{test}from'node:test';import assert from'node:assert/strict';import{DatabaseSync}from'node:sqlite';import{createMessenger}from'./messenger.mjs';
test('private durable message flow: membership, retries, quote, edit, recall, read and preferences',async()=>{
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT)');for(const id of ['a','b','outsider'])db.prepare('INSERT INTO users VALUES(?,?)').run(id,id);
 const events=[];const service=createMessenger(db,{publicUser:u=>({...u,name:u.username}),banned:()=>false,send:(uid,t,d)=>events.push({uid,t,d})});
 async function call(user,path,method='GET',data={}){let result;await service.handler({path,url:new URL(path,'http://test'),req:{method},auth:()=>({id:user}),body:async()=>data,reply:r=>result=r});return result;}
 try{
 const conv=await call('a','/v1/dm/direct','POST',{userId:'b'}),cid=conv.id;
 assert.equal((await call('b','/v1/dm/direct','POST',{userId:'a'})).id,cid);
 const send=(user,content,clientId,replyToId)=>call(user,`/v1/dm/conversations/${cid}/messages`,'POST',{content,clientId,replyToId});
 const msg=await send('a','hello','id-1');assert.equal((await send('a','hello','id-1')).id,msg.id);
 assert.equal((await call('b','/v1/inbox')).totalUnread,1);
 await assert.rejects(call('outsider',`/v1/inbox/dm-${cid}/items`),{status:403});
 await assert.rejects(call('outsider',`/v1/dm/messages/${msg.id}`,'PATCH',{content:'hack'}),{status:403});
 await assert.rejects(call('b',`/v1/dm/messages/${msg.id}`,'DELETE'),{status:403});
 const reply=await send('b','reply','id-2',msg.id);assert.equal(reply.replyTo.content,'hello');
 await call('a',`/v1/dm/messages/${msg.id}`,'PATCH',{content:'edited'});
 assert.equal((await call('b',`/v1/inbox/dm-${cid}/items`)).items[1].message.content,'edited');
 await call('a',`/v1/dm/messages/${msg.id}`,'DELETE');
 const history=(await call('b',`/v1/inbox/dm-${cid}/items`)).items;
 assert.equal(history[0].message.replyTo.withdrawn,true);assert.equal(history[0].message.replyTo.content,'');assert.equal(history[1].message.content,'');
 await call('b',`/v1/inbox/dm-${cid}/read`,'POST');assert.equal((await call('b','/v1/inbox')).totalUnread,0);
 await call('a',`/v1/dm/conversations/${cid}`,'PATCH',{pinned:true,muted:true});assert.equal((await call('a','/v1/inbox')).items[0].pinned,true);
 await call('a',`/v1/dm/conversations/${cid}/leave`,'POST');assert.equal((await call('a','/v1/inbox')).items.length,0);
 await send('b','reopen','id-3');assert.equal((await call('a','/v1/inbox')).items.length,1);
 assert.ok(events.some(e=>e.t==='dm.message.created'));assert.ok(events.every(e=>e.uid==='a'||e.uid==='b'));
 await call('a','/v1/inbox/read-all','POST');assert.equal((await call('a','/v1/inbox')).totalUnread,0);
 }finally{db.close();}
});
