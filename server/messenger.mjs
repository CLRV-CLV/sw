import { randomUUID } from 'node:crypto';
export function createMessenger(db,{publicUser,send,banned}) {
  db.exec(`CREATE TABLE IF NOT EXISTS dm_conversations(id TEXT PRIMARY KEY,pair TEXT UNIQUE,createdAt TEXT);
    CREATE TABLE IF NOT EXISTS dm_members(conversationId TEXT,userId TEXT,readSeq INTEGER DEFAULT 0,muted INTEGER DEFAULT 0,pinned INTEGER DEFAULT 0,hidden INTEGER DEFAULT 0,PRIMARY KEY(conversationId,userId));
    CREATE TABLE IF NOT EXISTS dm_messages(id TEXT PRIMARY KEY,conversationId TEXT,senderId TEXT,clientId TEXT,data TEXT,UNIQUE(senderId,clientId));`);
  const fail=(status,msg)=>Object.assign(new Error(msg),{status}), now=()=>new Date().toISOString();
  function member(cid,uid){const r=db.prepare('SELECT * FROM dm_members WHERE conversationId=? AND userId=?').get(cid,uid);if(!r)throw fail(403,'无权访问该会话');return r;}
  function messageView(raw){const m=typeof raw==='string'?JSON.parse(raw):{...raw};if(m.replyTo){const row=db.prepare('SELECT data FROM dm_messages WHERE id=? AND conversationId=?').get(m.replyTo.id,m.conversationId);const ref=row&&JSON.parse(row.data);m.replyTo={...m.replyTo,content:ref?.withdrawnAt?'':ref?.content||'',withdrawn:!ref||!!ref.withdrawnAt};}return m;}
  const peers=cid=>db.prepare('SELECT userId FROM dm_members WHERE conversationId=?').all(cid).map(r=>r.userId);
  function summary(cid,uid) {
    const m=member(cid,uid),peerId=peers(cid).find(id=>id!==uid),u=db.prepare('SELECT id,username FROM users WHERE id=?').get(peerId),last=db.prepare('SELECT data FROM dm_messages WHERE conversationId=? ORDER BY rowid DESC LIMIT 1').get(cid),msg=last?JSON.parse(last.data):null;
    return {id:cid,kind:'direct',peer:publicUser(u),muted:!!m.muted,pinned:!!m.pinned,activityAt:msg?.createdAt||db.prepare('SELECT createdAt FROM dm_conversations WHERE id=?').get(cid).createdAt,lastMessage:msg?{id:msg.id,createdAt:msg.createdAt,preview:msg.withdrawnAt?'消息已撤回':msg.content,senderId:msg.senderId}:null,unreadCount:db.prepare('SELECT count(*) n FROM dm_messages WHERE conversationId=? AND senderId!=? AND rowid>?').get(cid,uid,m.readSeq).n};
  }
  function notify(cid,type,message){for(const uid of peers(cid)){send(uid,type,{conversationId:cid,messageId:message?.id,message});send(uid,'dm.conversation.updated',{conversationId:cid,...summary(cid,uid)});}}
  function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
  const handler=async({path,req,url,auth,body,reply})=>{
    if(!path.startsWith('/v1/dm/')&&!path.startsWith('/v1/inbox'))return false;
    const user=auth(),method=req.method;
    if(path==='/v1/dm/contacts'&&method==='GET') {const q=(url.searchParams.get('q')||'').slice(0,40).toLowerCase();reply({items:db.prepare('SELECT id,username FROM users WHERE id!=? ORDER BY rowid DESC LIMIT 500').all(user.id).filter(u=>!banned(u)&&(!q||u.username.toLowerCase().includes(q)||publicUser(u).name.toLowerCase().includes(q))).slice(0,50).map(publicUser)});return true;}
    if(path==='/v1/dm/direct'&&method==='POST') {
      const b=await body(req),target=db.prepare('SELECT id,username FROM users WHERE id=?').get(String(b.userId||''));if(!target||target.id===user.id||banned(target))throw fail(400,'不能与此账号建立会话');
      const pair=[user.id,target.id].sort().join(':'),cid=transaction(()=>{let r=db.prepare('SELECT id FROM dm_conversations WHERE pair=?').get(pair);if(!r){r={id:randomUUID()};db.prepare('INSERT INTO dm_conversations VALUES(?,?,?)').run(r.id,pair,now());for(const uid of [user.id,target.id])db.prepare('INSERT INTO dm_members(conversationId,userId) VALUES(?,?)').run(r.id,uid);}db.prepare('UPDATE dm_members SET hidden=0 WHERE conversationId=? AND userId=?').run(r.id,user.id);return r.id;});reply(summary(cid,user.id));return true;
    }
    if(path==='/v1/inbox'&&method==='GET') {
      const all=db.prepare('SELECT conversationId FROM dm_members WHERE userId=? AND hidden=0').all(user.id).map(r=>summary(r.conversationId,user.id)).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.activityAt.localeCompare(a.activityAt));
      const offset=Math.max(0,Number(url.searchParams.get('cursor'))||0),limit=Math.min(50,Math.max(1,Number(url.searchParams.get('limit'))||20));
      reply({items:all.slice(offset,offset+limit).map(c=>({key:`dm-${c.id}`,kind:'conversation',conversationId:c.id,conversationKind:'direct',peer:c.peer,activityAt:c.activityAt,preview:c.lastMessage?{at:c.lastMessage.createdAt,fromMe:c.lastMessage.senderId===user.id,kind:'text',text:c.lastMessage.preview}:null,unreadCount:c.unreadCount,muted:c.muted,pinned:c.pinned})),nextCursor:offset+limit<all.length?String(offset+limit):null,totalUnread:all.reduce((s,c)=>s+c.unreadCount,0)});return true;
    }
    if(path==='/v1/inbox/read-all'&&method==='POST'){for(const r of db.prepare('SELECT conversationId FROM dm_members WHERE userId=?').all(user.id))db.prepare('UPDATE dm_members SET readSeq=(SELECT COALESCE(MAX(rowid),0) FROM dm_messages WHERE conversationId=?) WHERE conversationId=? AND userId=?').run(r.conversationId,r.conversationId,user.id);send(user.id,'inbox.read.all',{});reply({ok:true});return true;}
    const inbox=path.match(/^\/v1\/inbox\/([^/]+)\/(items|read)$/);
    if(inbox){const key=decodeURIComponent(inbox[1]),cid=key.replace(/^dm-/,'');member(cid,user.id);
      if(inbox[2]==='items'&&method==='GET'){const cursor=Math.max(0,Number(url.searchParams.get('cursor'))||Number.MAX_SAFE_INTEGER),limit=50,rows=db.prepare('SELECT rowid seq,data FROM dm_messages WHERE conversationId=? AND rowid<? ORDER BY rowid DESC LIMIT ?').all(cid,cursor,limit+1);reply({items:rows.slice(0,limit).map(r=>({type:'message',message:messageView(r.data)})),nextCursor:rows.length>limit?String(rows[limit-1].seq):null});return true;}
      if(inbox[2]==='read'&&method==='POST'){db.prepare('UPDATE dm_members SET readSeq=(SELECT COALESCE(MAX(rowid),0) FROM dm_messages WHERE conversationId=?) WHERE conversationId=? AND userId=?').run(cid,cid,user.id);send(user.id,'inbox.read',{key,lastReadAt:now()});reply({ok:true});return true;}
    }
    const conv=path.match(/^\/v1\/dm\/conversations\/([^/]+)(?:\/(messages|leave))?$/);
    if(conv){const cid=decodeURIComponent(conv[1]);member(cid,user.id);
      if(!conv[2]&&method==='PATCH'){const b=await body(req);if(Object.keys(b).some(k=>!['muted','pinned'].includes(k))||Object.values(b).some(v=>typeof v!=='boolean'))throw fail(400,'无效会话设置');for(const [k,v]of Object.entries(b))db.prepare(`UPDATE dm_members SET ${k}=? WHERE conversationId=? AND userId=?`).run(Number(v),cid,user.id);reply(summary(cid,user.id));return true;}
      if(conv[2]==='leave'&&method==='POST'){db.prepare('UPDATE dm_members SET hidden=1 WHERE conversationId=? AND userId=?').run(cid,user.id);send(user.id,'dm.conversation.left',{conversationId:cid});reply({ok:true});return true;}
      if(!conv[2]&&method==='GET'){reply(summary(cid,user.id));return true;}
      if(conv[2]==='messages'&&method==='POST') {
        const b=await body(req);if(typeof b.content!=='string'||!b.content.trim()||b.content.length>10000||typeof b.clientId!=='string'||!b.clientId||b.clientId.length>100)throw fail(400,'消息需1–10000字和客户端标识');
        if(peers(cid).some(id=>banned({id})))throw fail(403,'对方账号不可用');
        const existing=db.prepare('SELECT data,conversationId FROM dm_messages WHERE senderId=? AND clientId=?').get(user.id,b.clientId);if(existing){if(existing.conversationId!==cid)throw fail(409,'重复消息标识');reply(JSON.parse(existing.data));return true;}
        let replyTo=null;if(b.replyToId){const row=db.prepare('SELECT data FROM dm_messages WHERE id=? AND conversationId=?').get(b.replyToId,cid);if(!row)throw fail(400,'引用消息无效');const m=JSON.parse(row.data);replyTo={id:m.id,senderId:m.senderId,content:m.withdrawnAt?'':m.content,withdrawn:!!m.withdrawnAt};}
        const msg={id:randomUUID(),conversationId:cid,senderId:user.id,kind:'text',content:b.content,createdAt:now(),replyTo};
        transaction(()=>{db.prepare('INSERT INTO dm_messages VALUES(?,?,?,?,?)').run(msg.id,cid,user.id,b.clientId,JSON.stringify(msg));db.prepare('UPDATE dm_members SET hidden=0 WHERE conversationId=?').run(cid);});notify(cid,'dm.message.created',msg);reply(msg,201);return true;
      }
    }
    const message=path.match(/^\/v1\/dm\/messages\/([^/]+)$/);
    if(message&&['PATCH','DELETE'].includes(method)){const row=db.prepare('SELECT * FROM dm_messages WHERE id=?').get(decodeURIComponent(message[1]));if(!row)throw fail(404,'消息不存在');member(row.conversationId,user.id);if(row.senderId!==user.id)throw fail(403,'只能修改自己的消息');const msg=JSON.parse(row.data);if(msg.withdrawnAt)throw fail(409,'消息已经撤回');if(method==='PATCH'){const b=await body(req);if(typeof b.content!=='string'||!b.content.trim()||b.content.length>10000)throw fail(400,'无效消息');msg.content=b.content;msg.editedAt=now();}else{msg.content='';msg.withdrawnAt=now();}db.prepare('UPDATE dm_messages SET data=? WHERE id=?').run(JSON.stringify(msg),msg.id);notify(row.conversationId,method==='PATCH'?'dm.message.edited':'dm.message.withdrawn',msg);reply(msg);return true;}
    throw fail(404,'敲敲接口不存在');
  };
  return {handler,typing(cid,uid){member(cid,uid);for(const id of peers(cid))if(id!==uid)send(id,'dm.typing',{conversationId:cid,userId:uid});}};
}
