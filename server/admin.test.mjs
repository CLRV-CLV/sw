import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAdmin } from './admin.mjs';
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT, password TEXT,salt TEXT); CREATE TABLE sessions(token TEXT PRIMARY KEY,userId TEXT,expires INTEGER); CREATE TABLE posts(id TEXT PRIMARY KEY,data TEXT); CREATE TABLE comments(id TEXT PRIMARY KEY,postId TEXT,data TEXT); CREATE TABLE reactions(userId TEXT,targetId TEXT,kind TEXT);`);
  db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('a','owner','PASSWORD_HASH','SECRET_SALT');
  db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('u','member','PASSWORD_HASH','SECRET_SALT');
  const admin = createAdmin(db,{env:{ADMIN_USERNAMES:'owner'}});
  async function call(path, method='GET', data={}, actor='a') { let result; const user = db.prepare('SELECT * FROM users WHERE id=?').get(actor); await admin.handler({path,url:new URL(path,'http://test'),req:{method},body:async()=>data,auth:()=>{if(!user)throw Object.assign(new Error('login'),{status:401});return user;},reply:value=>result=value});return result; }
  return {db,admin,call};
}
test('server authorization denies guests and ordinary users; no credential disclosure',async()=>{
  const {db,call}=fixture(); try {
    await assert.rejects(call('/v1/admin/users','GET',{},'unknown'),{status:401});
    await assert.rejects(call('/v1/admin/users','GET',{},'u'),{status:403});
    const result=JSON.stringify(await call('/v1/admin/users'));
    assert.ok(!result.includes('PASSWORD_HASH')&&!result.includes('SECRET_SALT'));
  } finally {db.close();}
});
test('permissions, bans, session revocation and self-protection are enforced',async()=>{
  const {db,call,admin}=fixture();try {
    await assert.rejects(call('/v1/admin/users/a','PATCH',{banned:true}),{status:400});
    await assert.rejects(call('/v1/admin/users/a','PATCH',{role:'user'}),{status:400});
    await call('/v1/admin/users/u','PATCH',{role:'admin'});
    assert.equal(admin.isAdmin({id:'u',username:'member'}),true);
    await call('/v1/admin/users/u','PATCH',{role:'user'});
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('private-token','u',Date.now()+10000);
    await call('/v1/admin/users/u','PATCH',{banned:true});
    assert.equal(admin.banned({id:'u'}),true);assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n,0);
    await call('/v1/admin/users/u','PATCH',{banned:false});
    assert.equal(admin.banned({id:'u'}),false);
    assert.ok((await call('/v1/admin/audit')).total>=4);
  } finally{db.close();}
});
test('post editing, publication, cascading deletes and audit are transactional',async()=>{
  const {db,call}=fixture();try {
    db.prepare('INSERT INTO posts VALUES(?,?)').run('p',JSON.stringify({id:'p',title:'demo',body:'source',status:'published'}));
    for(const [id,parentId] of [['c',null],['r','c'],['nested','r']])db.prepare('INSERT INTO comments VALUES(?,?,?)').run(id,'p',JSON.stringify({id,parentId,body:'comment'}));
    db.prepare('INSERT INTO reactions VALUES(?,?,?)').run('u','nested','like');
    await call('/v1/admin/posts/p','PATCH',{status:'draft',title:'edited'});
    assert.equal((await call('/v1/admin/posts')).items[0].status,'draft');
    await assert.rejects(call('/v1/admin/posts/p','PATCH',{authorId:'a'}),{status:400});
    await call('/v1/admin/comments/c','DELETE');
    assert.equal(db.prepare('SELECT count(*) n FROM comments').get().n,0);
    assert.equal(db.prepare('SELECT count(*) n FROM reactions').get().n,0);
    await call('/v1/admin/posts/p','DELETE');
    assert.equal((await call('/v1/admin/posts')).total,0);
    assert.equal((await call('/v1/admin/audit')).total,3);
  }finally{db.close();}
});
test('settings accept only explicit supported boolean fields',async()=>{
  const {db,call,admin}=fixture();try {
    await call('/v1/admin/settings','PATCH',{registrationOpen:false,postingOpen:false});
    assert.equal(admin.settings().registrationOpen,false);assert.equal(admin.settings().postingOpen,false);
    await assert.rejects(call('/v1/admin/settings','PATCH',{exec:'rm'}),{status:400});
  }finally{db.close();}
});
