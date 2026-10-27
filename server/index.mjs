import { createPremium } from './premium.mjs';
import { createEmailAuth } from './email-auth.mjs';
import { createActivity } from './activity.mjs';
import { createCommunity, validateVideos } from './community.mjs';
import { createUploads } from './uploads.mjs';
import { createResidentAI } from './ai/index.mjs';
import { createMessenger } from './messenger.mjs';
import { createProfiles, validateProfile } from './site-data.mjs';
import { createAdmin } from './admin.mjs';
import { createConnections } from './connections.mjs';
import { renderAvatarSvg, renderCoverSvg } from './art.mjs';
import http from "node:http";
import { WebSocketServer } from "ws";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, existsSync, statSync, createReadStream } from "node:fs";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SEED_POSTS,
  SEED_USERS,
  ZZZ_COVERS,
  SEED_CATEGORIES,
  SEED_COMMENTS,
} from "./seed.mjs";
const dir =
  process.env.DATA_DIR || fileURLToPath(new URL("./data/", import.meta.url));
mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(`${dir}/interknot.sqlite`);
db.exec(
  `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, salt TEXT); CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, userId TEXT, expires INTEGER); CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY, data TEXT);`,
);
db.exec(
  `CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY, postId TEXT, data TEXT); CREATE TABLE IF NOT EXISTS reactions(userId TEXT, targetId TEXT, kind TEXT, PRIMARY KEY(userId,targetId,kind));`,
);
db.exec("CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY,value TEXT)");
const shouldSeed = process.env.SEED_DEMO !== '0' && !db.prepare("SELECT value FROM app_meta WHERE key='demo_initialized'").get();
if (shouldSeed) {
db.exec("BEGIN");
for (const c of SEED_COMMENTS.filter((c) => c.postId !== "post-101"))
  db.prepare("INSERT OR IGNORE INTO comments VALUES (?,?,?)").run(
    c.id,
    c.postId,
    JSON.stringify({ ...c, createdAt: new Date().toISOString() }),
  );
const seedInsert = db.prepare("INSERT OR IGNORE INTO posts VALUES (?,?)");
for (const p of SEED_POSTS.filter((p) => p.id !== "post-101"))
  seedInsert.run(
    p.id,
    JSON.stringify({ ...p, publishedAt: new Date().toISOString() }),
  );
db.prepare("INSERT OR IGNORE INTO app_meta VALUES('demo_initialized','1')").run();
db.exec("COMMIT");
}
db.prepare("INSERT OR IGNORE INTO app_meta VALUES('demo_initialized','1')").run();
const insert = db.prepare("INSERT OR IGNORE INTO posts VALUES (?,?)");
const profiles = createProfiles(db);
const premium=createPremium(db,profiles);
const uploads = createUploads(db,profiles,{premium});
const activity=createActivity(db);
const publicUser = (u) => ({
  id: u.id,
  name: profiles.get(u.id).nickname || u.username,
  nickname: profiles.get(u.id).nickname,
  bio: profiles.get(u.id).bio,
  role: admin.isAdmin(u) ? "admin" : "user",
  username: u.username,
  level: profiles.get(u.id).level,
  exp: profiles.get(u.id).exp,

  examPassed: true,
  avatarUrl: profiles.get(u.id).avatarUrl || u.avatarUrl || (["avatar-nicole", "avatar-anby", "avatar-billy"].includes(u.avatarSlug) ? `/images/agent-${u.avatarSlug.slice(7)}.webp` : `/media/avatar/${u.avatarSlug || "avatar-bangboo"}.svg`),
});
const fail = (status, detail) => Object.assign(new Error(detail), { status });
async function body(req,limit=1048576) {
  const chunks=[];let size=0;
  for await(const c of req){size+=c.length;if(size>limit)throw fail(413,"请求过大");chunks.push(c);}
  try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw Error('object');return value;}
  catch{throw fail(400,"无效 JSON");}
}

const sockets = new WebSocketServer({ noServer: true, maxPayload: 16384 });
const broadcast = (t, d) => {
  for (const ws of sockets.clients)
    if (ws.readyState === 1) ws.send(JSON.stringify({ op: "event", t, d }));
};
const connections = createConnections();
const admin = createAdmin(db, { broadcast, onPostApproved:premium.approvePost });
function issueSession(u,req,res){
 const t=randomBytes(32).toString('hex');
 db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(t,u.id,Date.now()+604800000);
 db.prepare('INSERT OR REPLACE INTO session_info VALUES(?,?,?,?)').run(t,String(req.headers['user-agent']||'').slice(0,500),req.socket.remoteAddress||'',new Date().toISOString());
 res.setHeader('Set-Cookie',`ik_session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.SECURE_COOKIE==='1'?'; Secure':''}`);
 return {token:t,user:{...publicUser(u),email:emailAuth.emailOf(u.id),denny:profiles.get(u.id).denny,polychrome:profiles.get(u.id).polychrome}};
}
const emailAuth=createEmailAuth(db,{admin,publicUser,profiles,dataDir:dir,issueSession});
const community=createCommunity(db,{profiles,admin,publicUser,uploads,broadcast,emailConfigured:()=>emailAuth.configured});
const sessionUser = token => {
  const session=token&&db.prepare('SELECT userId FROM sessions WHERE token=? AND expires>?').get(token,Date.now());
  const u=session&&db.prepare('SELECT id,username FROM users WHERE id=?').get(session.userId);return u&&!admin.banned(u)?u:null;
};
const messenger=createMessenger(db,{publicUser,banned:admin.banned,send(uid,t,d){for(const ws of sockets.clients)if(ws.readyState===1&&sessionUser(ws.sessionToken)?.id===uid)ws.send(JSON.stringify({op:'event',t,d}));}});
const residentAI=createResidentAI(db,{admin,broadcast,dataDir:dir,send(uid,t,d){for(const ws of sockets.clients)if(ws.readyState===1&&sessionUser(ws.sessionToken)?.id===uid)ws.send(JSON.stringify({op:'event',t,d}));}});
const app = http.createServer(async (req, res) => {
  const reply = (data, status = 200) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  try {
    const url = new URL(req.url, "http://local");
    const path = url.pathname;
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin
    ) {
      let origin;
      try {
        origin = new URL(req.headers.origin).host;
      } catch {
        throw fail(403, "无效来源");
      }
      if (origin !== req.headers.host) throw fail(403, "禁止跨站写入");
    }
    if (
      !path.startsWith("/v1/") &&
      !path.startsWith("/media/") &&
      path !== "/health"
    ) {
      const root = resolve(
        fileURLToPath(new URL("./public/", import.meta.url)),
      );
      const file = resolve(root, "." + decodeURIComponent(path));
      if (!file.startsWith(root + sep) && file !== root)
        throw fail(403, "无效路径");
      const asset =
        existsSync(file) && statSync(file).isFile()
          ? file
          : resolve(root, "index.html");
      if (existsSync(asset)) {
        res.writeHead(200, {
          "content-type":
            {
              ".html": "text/html; charset=utf-8",
              ".js": "text/javascript",
              ".css": "text/css",
              ".svg": "image/svg+xml",
              ".png": "image/png",
              ".webp": "image/webp",
              ".gif": "image/gif",
              ".ttf": "font/ttf",
              ".woff2": "font/woff2",
            }[extname(asset)] || "application/octet-stream",
        });
        return createReadStream(asset).pipe(res);
      }
    }

    const token =
      req.headers.authorization?.replace(/^Bearer /, "") ||
      req.headers.cookie?.match(/(?:^|; )ik_session=([^;]+)/)?.[1];
    const session =
      token &&
      db
        .prepare("SELECT * FROM sessions WHERE token=? AND expires>?")
        .get(token, Date.now());
    const user =
      session &&
      db.prepare("SELECT * FROM users WHERE id=?").get(session.userId);
    const auth = () => {
      if (!user) throw fail(401, "请先登录");
      if (admin.banned(user)) throw fail(403, "账号已被封禁");
      return user;
    };
    if (await emailAuth.handler({path,req,res,auth,body,reply})) return;
    if (await uploads.handler({path,req,url,auth,body,reply,res})) return;
    if (await residentAI.handler({path,req,url,auth,body,reply})) return;
    if (await activity.handler({path,req,url,auth,body,reply})) return;
    if (await community.handler({path,req,url,auth,body,reply,user,token})) return;
    if (await admin.handler({ path, req, url, auth, body, reply })) return;
    if (await messenger.handler({ path, req, url, auth, body, reply, fileReply(bytes,a){res.writeHead(200,{'content-type':a.mime,'content-length':bytes.length,'content-disposition':`${a.type==='image'||a.type==='audio'?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name).replace(/'/g,'%27')}`,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"});res.end(bytes);} })) return;
    if (await connections({ path, req, res, url, auth, reply })) return;
    if (path === '/v1/site' && req.method === 'GET') { const {siteTitle,siteIcon,siteBackground,backgroundColor}=admin.settings();return reply({siteTitle,siteIcon,siteBackground,backgroundColor}); }
    if (path === "/health") return reply({ ok: true });
    if (/^\/media\/(avatar|cover)\/[\w-]+\.svg$/.test(path)) {
      const [, , kind, file] = path.split("/");
      res.writeHead(200, {
        "content-type": "image/svg+xml",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'",
      });
      return res.end(
        (kind === "avatar" ? renderAvatarSvg : renderCoverSvg)(
          file.slice(0, -4),
        ),
      );
    }
    if (path === "/v1/auth/register" && req.method === "POST") {
      if (!admin.settings().registrationOpen) throw fail(403, "注册暂时关闭");
      const b = await body(req);
      if (b.email !== undefined) { const u=emailAuth.register(b); return reply(issueSession(u,req,res),201); }
      if (
        typeof b.username !== "string" ||
        b.username.trim().length < 2 ||
        b.username.length > 40 ||
        typeof b.password !== "string" ||
        (b.password.length < 10 || b.password.length > 200)
      )
        throw fail(400, "用户名需2–40字，密码至少10字");
      const salt = randomBytes(16).toString("hex");
      const id = randomUUID();
      try {
        // Single SQLite transaction: concurrent registrations cannot both win.
        const passwordHash = scryptSync(b.password, salt, 64).toString("hex");
        db.exec("BEGIN IMMEDIATE");
        const first = !db.prepare("SELECT value FROM app_meta WHERE key='admin_bootstrapped'").get()
          && db.prepare("SELECT count(*) n FROM users").get().n === 0;
        db.prepare("INSERT INTO users VALUES (?,?,?,?)").run(id, b.username.trim(), passwordHash, salt);
        if (first && process.env.AUTO_FIRST_ADMIN !== '0') {
          db.prepare("INSERT OR REPLACE INTO user_access VALUES(?,'admin',0)").run(id);
          db.prepare("INSERT INTO admin_audit VALUES(?,?,?,?,?)").run(randomUUID(),id,'admin.bootstrap',id,new Date().toISOString());
        }
        db.prepare("INSERT OR IGNORE INTO app_meta VALUES('admin_bootstrapped','1')").run();
        db.exec("COMMIT");
      } catch (e) {
        if (db.isTransaction) db.exec("ROLLBACK");
        if (String(e.message).includes('UNIQUE')) throw fail(409, "用户名已存在");
        throw e;
      }
      return reply({ id, username: b.username.trim() }, 201);
    }
    if (path === "/v1/auth/login" && req.method === "POST") {
      const b = await body(req);
      const identifier=String(b.username||b.account||b.identifier||'').trim();
      const u=(identifier.includes('@')?emailAuth.ownerOf(identifier.toLowerCase()):null)||db.prepare('SELECT * FROM users WHERE username=?').get(identifier);
      if (
        !u ||
        typeof b.password !== "string" || b.password.length>200 ||
        !timingSafeEqual(
          Buffer.from(u.password, "hex"),
          scryptSync(b.password, u.salt, 64),
        )
      )
        throw fail(401, "用户名或密码错误");
      if (admin.banned(u)) throw fail(403, "账号已被封禁");
      return reply(issueSession(u,req,res));
    }
    if (path === "/v1/auth/logout" && req.method === "POST") {
      db.prepare("DELETE FROM sessions WHERE token=?").run(token || "");
      res.setHeader(
        "Set-Cookie",
        "ik_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      );
      return reply({ ok: true });
    }
    if (path === "/v1/me") {const u=auth(),p=profiles.get(u.id);return reply({...publicUser(u),email:emailAuth.emailOf(u.id),denny:p.denny,polychrome:p.polychrome});}
    if (path === "/v1/categories") return reply(SEED_CATEGORIES);
    if (path === "/v1/me/profile") {
      auth();
      if (req.method === 'PATCH') { const patch=await body(req); if(Object.keys(patch).some(k=>!['bio','hidden'].includes(k))||!validateProfile(patch))throw fail(400,'无效个人资料');profiles.set(user.id,patch); }
      return reply({ ...profiles.get(user.id), pinnedPostIds:community.pins(user.id), avatar: { url: publicUser(user).avatarUrl } });
    }
    if (path === "/v1/me/exp") {
      auth();
      return reply({ level: profiles.get(user.id).level, exp: profiles.get(user.id).exp });
    }
    if (path === "/v1/me/wallet") {
      auth();
      return reply({ balance: profiles.get(user.id).denny, polychrome: profiles.get(user.id).polychrome });
    }
    const profileMatch=path.match(/^\/v1\/users\/([^/]+)$/);
    if(profileMatch && req.method==='GET') {
      const id=decodeURIComponent(profileMatch[1]);const target=db.prepare('SELECT id,username FROM users WHERE id=?').get(id)||SEED_USERS.find(u=>u.id===id)||residentAI.author(id);
      if(!target)throw fail(404,'用户不存在');const p=profiles.get(id),me=publicUser(target),self=user?.id===id;
      if(p.hidden&&!self&&!admin.isAdmin(user))return reply({id,username:me.name,isHidden:true,isSelf:false});
      const posts=db.prepare('SELECT data FROM posts').all().map(r=>JSON.parse(r.data)).filter(p=>p.authorId===id&&p.status!=='draft');
      const {denny,polychrome,...publicProfile}=p;
      return reply({...me,username:me.name,login:target.username,avatar:{url:me.avatarUrl},...publicProfile,...(self||admin.isAdmin(user)?{denny,polychrome}:{}),isSelf:self,isHidden:p.hidden,pinnedPostIds:community.pins(id),equippedCard:community.card(id),isFollowing:!!user&&community.following(user.id,id),isBlockedByMe:!!user&&community.blocked(user.id,id),hasBlockedMe:!!user&&community.blocked(id,user.id),followerCount:db.prepare("SELECT count(*) n FROM user_follows WHERE peerId=?").get(id).n,followingCount:db.prepare("SELECT count(*) n FROM user_follows WHERE userId=?").get(id).n,stats:{postCount:posts.length,commentCount:db.prepare("SELECT count(*) n FROM comments WHERE json_extract(data,'$.authorId')=?").get(id).n,totalViews:posts.reduce((sum,p)=>sum+(p.viewCount||0),0)}});
    }
    const reactionCount = (id, kind) =>
      Number(
        db
          .prepare(
            "SELECT count(*) AS n FROM reactions WHERE targetId=? AND kind=?",
          )
          .get(id, kind).n,
      );
    const reacted = (id, kind) =>
      !!(
        user &&
        db
          .prepare(
            "SELECT 1 FROM reactions WHERE userId=? AND targetId=? AND kind=?",
          )
          .get(user.id, id, kind)
      );
    const postById = (id) => {
      const r = db.prepare("SELECT data FROM posts WHERE id=?").get(id);
      if (!r) throw fail(404, "帖子不存在");
      return JSON.parse(r.data);
    };
    const commentView = (c) => ({
      ...c,
      isPinned:!!c.pinned,isAccepted:!!c.accepted,
      ...(c.isAnonymous?{authorId:''}:{}),
      author: c.isAnonymous ? {id:'',anonymous:true,name:'匿名绳匠',avatarUrl:'/images/default-avatar.webp'} : publicUser(
        SEED_USERS.find((u) => u.id === c.authorId) ||
          db.prepare("SELECT * FROM users WHERE id=?").get(c.authorId) || {
            id: c.authorId,
            username: "绳匠",
          },
      ),
      likeCount: (c.likeCount || 0) + reactionCount(c.id, "like"),
      liked: reacted(c.id, "like"),
    });
    const interaction = path.match(
      /^\/v1\/(posts|comments)\/([^/]+)\/(like|favorite)$/,
    );
    if (interaction && ["PUT", "DELETE"].includes(req.method)) {
      auth();
      const [, type, id, kind] = interaction;
      if (type === "comments" && kind === "favorite")
        throw fail(404, "不支持收藏评论");
      const r = db.prepare(`SELECT data FROM ${type} WHERE id=?`).get(id);
      if (!r) throw fail(404, "目标不存在");
      if (type === "posts" && JSON.parse(r.data).status === "draft")
        throw fail(404, "帖子尚未发布");
      if (req.method === "PUT")
        db.prepare("INSERT OR IGNORE INTO reactions VALUES (?,?,?)").run(
          user.id,
          id,
          kind,
        );
      else
        db.prepare(
          "DELETE FROM reactions WHERE userId=? AND targetId=? AND kind=?",
        ).run(user.id, id, kind);
      if(kind==='like'&&req.method==='PUT')community.award(user.id,'likeGive',1);
      return reply({
        liked: reacted(id, "like"),
        favorited: reacted(id, "favorite"),
        likeCount:
          (JSON.parse(r.data).likeCount || 0) + reactionCount(id, "like"),
        favoriteCount:
          (JSON.parse(r.data).favoriteCount || 0) +
          reactionCount(id, "favorite"),
      });
    }
    const cm = path.match(/^\/v1\/posts\/([^/]+)\/comments$/);
    if (cm) {
      if (postById(cm[1]).status === "draft") throw fail(404, "帖子尚未发布");
      if (req.method === "POST") {
        auth();
        const b = await body(req);
        if (
          typeof b.body !== "string" ||
          (!b.body.trim() && !b.imageIds?.length) ||
          b.body.length > 10000
        )
          throw fail(400, "评论需1–10000字");
        let parentId = b.parentId || null;
        if (parentId) {
          const row = db
            .prepare("SELECT * FROM comments WHERE id=? AND postId=?")
            .get(parentId, cm[1]);
          if (!row) throw fail(400, "回复目标无效");
          const parent = JSON.parse(row.data);
          parentId = parent.parentId || parent.id;
        }
        if('isAnonymous' in b && typeof b.isAnonymous!=='boolean')throw fail(400,'无效匿名设置');
        if((b.imageIds?.length||0)>community.benefits(user.id).benefits.commentMaxImages)throw fail(400,'超过当前等级的评论图片数量限制');
        const c = {
          id: randomUUID(),
          postId: cm[1],
          authorId: user.id,
          body: b.body,
          images: uploads.resolveImages(b.imageIds||[],user),
          isAnonymous:b.isAnonymous===true,
          parentId,
          createdAt: new Date().toISOString(),
        };
        db.prepare("INSERT INTO comments VALUES (?,?,?)").run(
          c.id,
          c.postId,
          JSON.stringify(c),
        );
        community.award(user.id,'createComment',3);
        const owner=postById(cm[1]).authorId;if(owner!==user.id)activity.notify(owner,'comment','你的委托收到新评论',`/post/${cm[1]}`,`comment:${c.id}`);
        return reply(commentView(c), 201);
      }
      if (req.method === "GET") {
        const all = db
          .prepare("SELECT data FROM comments WHERE postId=?")
          .all(cm[1])
          .map((r) => JSON.parse(r.data));
        return reply({
          items: all
            .filter((c) => !c.parentId)
            .map((c) => ({
              ...commentView(c),
              replies: all.filter((r) => r.parentId === c.id).map(commentView),
              replyCount: all.filter((r) => r.parentId === c.id).length,
            })),
          nextCursor: null,
        });
      }
    }
    const replies = path.match(/^\/v1\/comments\/([^/]+)\/replies$/);
    if (replies && req.method === "GET") {
      const row = db
        .prepare("SELECT * FROM comments WHERE id=?")
        .get(replies[1]);
      if (!row) throw fail(404, "评论不存在");
      if(postById(row.postId).status==='draft')throw fail(404,'帖子尚未发布');
      return reply({
        items: db
          .prepare("SELECT data FROM comments WHERE postId=?")
          .all(row.postId)
          .map((r) => JSON.parse(r.data))
          .filter((c) => c.parentId === replies[1])
          .map(commentView),
        nextCursor: null,
      });
    }
    if (/^\/v1\/posts\/[^/]+\/views$/.test(path) && req.method === "POST") {
      const p = postById(path.split("/")[3]);
      if (p.status === "draft") throw fail(404, "帖子尚未发布");
      p.viewCount = (p.viewCount || 0) + 1;
      db.prepare("UPDATE posts SET data=? WHERE id=?").run(
        JSON.stringify(p),
        p.id,
      );
      return reply({ viewCount: p.viewCount });
    }

    const toPost = (p) => ({
      ...p,
      ...community.enrich(p,user?.id),
      ...(p.isAnonymous?{authorId:''}:{}),
      isOwner: p.authorId === user?.id,
      liked: reacted(p.id, "like"),
      favorited: reacted(p.id, "favorite"),
      likeCount: (p.likeCount || 0) + reactionCount(p.id, "like"),
      favoriteCount: (p.favoriteCount || 0) + reactionCount(p.id, "favorite"),
      commentCount: db
        .prepare("SELECT count(*) AS n FROM comments WHERE postId=?")
        .get(p.id).n,
      excerpt: p.body.slice(0, 160),
      author: p.isAnonymous?{id:'',anonymous:true,name:'匿名绳匠',avatarUrl:'/images/default-avatar.webp'}:publicUser(
        residentAI.author(p.authorId) || SEED_USERS.find((u) => u.id === p.authorId) ||
          db.prepare("SELECT * FROM users WHERE id=?").get(p.authorId) || {
            id: p.authorId,
            username: "绳匠",
          },
      ),
      category: SEED_CATEGORIES.find((c) => c.id === p.categoryId),
      tags: (p.tags || []).map((t) => ({ slug: t, name: t })),
      cover: p.covers?.[0] || (p.coverSlug
        ? p.coverSlug === "cover-cunning-hares" ? {url: "/images/zzz.webp", width:1921, height:1537} : { url: `/media/cover/${p.coverSlug}.svg`, width: 800, height: ZZZ_COVERS[p.coverSlug]?.h || 508 }
        : null),
    });
    const userPosts=path.match(/^\/v1\/users\/([^/]+)\/posts$/);
    if(userPosts && req.method==='GET') {
      const id=decodeURIComponent(userPosts[1]);if(profiles.get(id).hidden&&user?.id!==id&&!admin.isAdmin(user))throw fail(403,'个人空间未公开');
      return reply({items:db.prepare('SELECT data FROM posts').all().map(r=>JSON.parse(r.data)).filter(p=>p.authorId===id&&p.status!=='draft'&&(!p.isAnonymous||user?.id===id)).map(toPost),nextCursor:null});
    }
    if (
      (path === "/v1/posts" ||
        ["/v1/feed/hot", "/v1/feed/unread"].includes(path) ||
        path === "/v1/search/posts") &&
      req.method === "GET"
    ) {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const items = db
        .prepare("SELECT data FROM posts")
        .all()
        .map((r) => JSON.parse(r.data))
        .filter((p) => p.status !== "draft")
        .filter(p=>!user||!community.blocked(user.id,p.authorId))
        .filter(p=>!path.endsWith('/unread') || !community.enrich(p,user?.id).isRead)
        .filter((p) => (p.title + p.body).toLowerCase().includes(q))
        .filter(
          (p) =>
            !url.searchParams.get("category") ||
            SEED_CATEGORIES.find((c) => c.id === p.categoryId)?.slug ===
              url.searchParams.get("category"),
        )
        .filter(
          (p) =>
            !url.searchParams.get("tag") ||
            (p.tags || []).includes(url.searchParams.get("tag")),
        )
        .sort((a, b) =>
          path.endsWith("/hot")
            ? (b.likeCount || 0) - (a.likeCount || 0)
            : b.publishedAt.localeCompare(a.publishedAt) ||
              b.id.localeCompare(a.id),
        )
        .map(toPost);
      const offset = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
      const limit = Math.min(
        100,
        Math.max(1, Number(url.searchParams.get("limit")) || 20),
      );
      return reply({
        items: items.slice(offset, offset + limit),
        nextCursor:
          offset + limit < items.length ? String(offset + limit) : null,
      });
    }
    if (path === "/v1/posts" && req.method === "POST") {
      if (!admin.settings().postingOpen && !admin.isAdmin(user)) throw fail(403, "发帖暂时关闭");
      auth();
      const b = await body(req);
      if('isAnonymous' in b && typeof b.isAnonymous!=='boolean')throw fail(400,'无效匿名设置');
      if (
        typeof b.title !== "string" ||
        b.title.length > 200 ||
        typeof b.body !== "string"
      )
        throw fail(400, "需要标题和正文");
      const p = {
        id: randomUUID(),
        title: b.title,
        body: b.body,
        covers: uploads.resolveImages(b.coverIds||[],user),
        isAnonymous:b.isAnonymous===true,
        externalVideos:validateVideos(b.externalVideos||[]),
        status: "draft",
        authorId: user.id,
        categoryId:
          SEED_CATEGORIES.find((c) => c.id === b.categoryId)?.id || null,
        tags: Array.isArray(b.tags)
          ? b.tags.filter((t) => typeof t === "string").slice(0, 10)
          : [],
        publishedAt: null,
        updatedAt: new Date().toISOString(),
      };
      community.validatePost(b,user.id);
      insert.run(p.id, JSON.stringify(p));
      return reply(
        { ...p, tags: p.tags.map((t) => ({ slug: t, name: t })) },
        201,
      );
    }
    if (/^\/v1\/posts\/[^/]+$/.test(path) && req.method === "GET") {
      const r = db
        .prepare("SELECT data FROM posts WHERE id=?")
        .get(path.split("/").at(-1));
      if (!r) throw fail(404, "帖子不存在");
      const raw = JSON.parse(r.data);
      if (raw.status === "draft") throw fail(404, "帖子尚未发布");
      const p = toPost(raw);
      return reply({ ...p, covers: p.covers?.length ? p.covers : (p.cover ? [p.cover] : []) });
    }
    const draftPath = path.match(
      /^\/v1\/posts\/([^/]+)\/(draft|publish|edit)$/,
    );
    if (draftPath) {
      auth();
      const p = postById(draftPath[1]);
      if (p.authorId !== user.id) throw fail(403, "仅作者可操作");
      if (draftPath[2] === "edit" && req.method === "GET")
        return reply({
          ...p,
          tags: (p.tags || []).map((t) => ({ slug: t, name: t })),
          covers: p.covers || [],
          videos: p.externalVideos || [],
        });
      if (draftPath[2] === "draft" && req.method === "PUT") {
        const b = await body(req);
        if('isAnonymous' in b && typeof b.isAnonymous!=='boolean')throw fail(400,'无效匿名设置');
        if (
          typeof b.title !== "string" ||
          b.title.length > 200 ||
          typeof b.body !== "string"
        )
          throw fail(400, "无效草稿");
        community.validatePost(b,user.id);
        const updated = {
          ...p,
          title: b.title,
          body: b.body,
          covers: uploads.resolveImages(b.coverIds||[],user),
          isAnonymous:b.isAnonymous===true,
          externalVideos:validateVideos(b.externalVideos||[]),
          categoryId:
            SEED_CATEGORIES.find((c) => c.id === b.categoryId)?.id || null,
          tags: Array.isArray(b.tags)
            ? b.tags.filter((t) => typeof t === "string").slice(0, 10)
            : [],
          updatedAt: new Date().toISOString(),
        };
        db.prepare("UPDATE posts SET data=? WHERE id=?").run(
          JSON.stringify(updated),
          p.id,
        );
        return reply({
          ...updated,
          tags: updated.tags.map((t) => ({ slug: t, name: t })),
        });
      }
      if (draftPath[2] === "publish" && req.method === "POST") {
        if (!p.title.trim() || !p.body.trim())
          throw fail(400, "发布需要标题和正文");
        p.status = "published";
        p.publishedAt = new Date().toISOString();
        db.prepare("UPDATE posts SET data=? WHERE id=?").run(
          JSON.stringify(p),
          p.id,
        );
        community.award(user.id,'createPost',4);
        broadcast("post.published", { postId: p.id });
        return reply({ id: p.id });
      }
    }
    if (path === "/v1/me/posts" && req.method === "GET") {
      auth();
      return reply({
        items: db
          .prepare("SELECT data FROM posts")
          .all()
          .map((r) => JSON.parse(r.data))
          .filter((p) => p.authorId === user.id)
          .filter((p) =>
            url.searchParams.get("state") === "draft"
              ? p.status === "draft"
              : p.status !== "draft",
          )
          .map(toPost),
        nextCursor: null,
      });
    }
    if (path === "/v1/me/favorites" && req.method === "GET") {
      auth();
      return reply({
        items: db
          .prepare("SELECT data FROM posts")
          .all()
          .map((r) => JSON.parse(r.data))
          .filter((p) => p.status !== "draft" && reacted(p.id, "favorite"))
          .map((p) => ({ post: toPost(p) })),
        nextCursor: null,
      });
    }
    throw fail(404, "此接口尚未实现");
  } catch (e) {
    reply(
      {
        status: e.status || 500,
        title: e.status ? "请求失败" : "服务器错误",
        detail: e.status ? e.message : "内部错误",
      },
      e.status || 500,
    );
  }
});
app.on("upgrade", (req, socket, head) => {
  if (req.url !== "/v1/realtime") {
    socket.destroy();
    return;
  }
  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) {
        socket.destroy();
        return;
      }
    } catch {
      socket.destroy();
      return;
    }
  }
  sockets.handleUpgrade(req, socket, head, (ws) => {
    ws.sessionToken=req.headers.authorization?.replace(/^Bearer /,'')||req.headers.cookie?.match(/(?:^|; )ik_session=([^;]+)/)?.[1];
    ws.send(JSON.stringify({ op: "hello", d: { userId: sessionUser(ws.sessionToken)?.id||null } }));
    ws.on("message", (data) => {
      try {
        const f = JSON.parse(data);
        if(f.op==='typing'){const u=sessionUser(ws.sessionToken);if(!u)throw Error('login');messenger.typing(String(f.d?.conversationId||''),u.id);}
        else if (["ping", "subscribe", "unsubscribe"].includes(f.op))
          ws.send(JSON.stringify({ op: "ack", seq: f.seq }));
        else
          ws.send(JSON.stringify({ op: "error", d: { code: "UNSUPPORTED" } }));
      } catch {
        ws.close(1003, "Invalid JSON");
      }
    });
  });
});
app.listen(Number(process.env.PORT || 3000), "0.0.0.0");
