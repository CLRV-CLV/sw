import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';

test('admin HTTP permissions, settings, ban and deletion persistence across restart', async () => {
  const data = mkdtempSync(`${tmpdir()}/ik-admin-`), origin = 'http://127.0.0.1:39126';
  let child;
  async function start() {
    child = spawn(process.execPath,['server/index.mjs'],{env:{...process.env,PORT:'39126',DATA_DIR:data,ADMIN_USERNAMES:''},stdio:'ignore'});
    for(let i=0;i<100;i++) { if(child.exitCode!==null)throw new Error('test server exited'); try{if((await fetch(origin+'/health')).ok)return;}catch{} await new Promise(r=>setTimeout(r,30)); }
    throw new Error('test server startup timeout');
  }
  async function stop() {if(child && child.exitCode===null){const exit=once(child,'exit');child.kill();await exit;}}
  async function call(path,method='GET',body,token) {
    const response=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    return [response.status,await response.json()];
  }
  try {
    await start();
    await call('/v1/auth/register','POST',{username:'owner',password:'a-long-test-password'});
    await call('/v1/auth/register','POST',{username:'member',password:'a-long-test-password'});
    assert.equal((await call('/v1/auth/register','POST',{username:'owner',password:'a-long-test-password'}))[0],409);
    const [,owner]=await call('/v1/auth/login','POST',{username:'owner',password:'a-long-test-password'});
    const [,member]=await call('/v1/auth/login','POST',{username:'member',password:'a-long-test-password'});
    assert.equal((await call('/v1/admin/users'))[0],401);
    assert.equal((await call('/v1/admin/users','GET',undefined,member.token))[0],403);
    const [,users]=await call('/v1/admin/users','GET',undefined,owner.token);
    assert.equal(users.items.find(u=>u.username==='owner').role,'admin');
    const memberId=users.items.find(u=>u.username==='member').id;
    assert.equal((await call('/v1/me','GET',undefined,owner.token))[1].role,'admin');
    assert.equal((await call(`/v1/admin/users/${memberId}`,'PATCH',{nickname:'安比测试',bio:'这里是简介',avatarUrl:'/images/default-avatar.webp',level:25,exp:120,denny:3000,polychrome:160},owner.token))[0],200);
    const [,profile]=await call(`/v1/users/${memberId}`,'GET',undefined,member.token);
    assert.equal((await call(`/v1/users/${memberId}`))[1].polychrome,undefined);
    assert.equal(profile.isSelf,true);assert.equal(profile.nickname,'安比测试');assert.equal(profile.level,25);
    assert.equal((await call(`/v1/users/${memberId}/posts`))[0],200);
    assert.equal((await call('/v1/me/wallet','GET',undefined,member.token))[1].polychrome,160);
    assert.equal((await call(`/v1/admin/users/${memberId}`,'PATCH',{polychrome:-1},owner.token))[0],400);
    assert.equal((await call('/v1/me/profile','PATCH',{polychrome:999},member.token))[0],400);
    assert.equal((await call('/v1/admin/settings','PATCH',{siteTitle:'新艾利都',siteIcon:'/icon/favicon-32x32.png',siteBackground:'https://example.test/bg.webp',backgroundColor:'#151515'},owner.token))[0],200);
    assert.equal((await call('/v1/site'))[1].siteTitle,'新艾利都');
    assert.equal((await call('/v1/admin/settings','PATCH',{siteIcon:'javascript:alert(1)'},owner.token))[0],400);

    assert.equal((await call(`/v1/admin/users/${memberId}`,'PATCH',{banned:true},owner.token))[0],200);
    assert.equal((await call('/v1/me','GET',undefined,member.token))[0],401);
    assert.equal((await call('/v1/auth/login','POST',{username:'member',password:'a-long-test-password'}))[0],403);
    assert.equal((await call('/v1/admin/settings','PATCH',{registrationOpen:false},owner.token))[0],200);
    assert.equal((await call('/v1/auth/register','POST',{username:'other',password:'a-long-test-password'}))[0],403);
    const [,posts]=await call('/v1/admin/posts','GET',undefined,owner.token);
    const id=posts.items[0].id;
    assert.equal((await call(`/v1/admin/posts/${id}`,'DELETE',undefined,owner.token))[0],200);
    const [,after]=await call('/v1/admin/overview','GET',undefined,owner.token);
    await stop();await start();
    const [,restarted]=await call('/v1/admin/overview','GET',undefined,owner.token);
    assert.equal(restarted.counts.posts,after.counts.posts);
    assert.equal(restarted.settings.registrationOpen,false);assert.equal(restarted.settings.siteTitle,'新艾利都');assert.equal((await call(`/v1/users/${memberId}`))[1].level,25);
    assert.equal((await call(`/v1/posts/${id}`))[0],404);
    assert.ok((await call('/v1/admin/audit','GET',undefined,owner.token))[1].total>=3);
  } finally {await stop();rmSync(data,{recursive:true,force:true});}
});
