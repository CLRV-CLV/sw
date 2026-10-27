import { createProfiles, validateProfile, safeImage } from './site-data.mjs';
import { randomUUID } from 'node:crypto';
export function createAdmin(db, { env = process.env, broadcast = () => {} } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS user_access(userId TEXT PRIMARY KEY, role TEXT NOT NULL DEFAULT 'user', banned INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS site_settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS admin_audit(id TEXT PRIMARY KEY,actor TEXT,action TEXT,target TEXT,createdAt TEXT);`);
  const profiles = createProfiles(db);
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const bootstrap = () => new Set((env.ADMIN_USERNAMES || '').split(',').map(s => s.trim()).filter(Boolean));
  const access = u => db.prepare('SELECT * FROM user_access WHERE userId=?').get(u.id) || { role: 'user', banned: 0 };
  const isAdmin = u => Boolean(u && (bootstrap().has(u.username) || access(u).role === 'admin'));
  const banned = u => Boolean(u && access(u).banned);
  const settings = () => ({ registrationOpen: true, postingOpen: true, siteTitle: "绳网", siteIcon: "/icon/favicon-32x32.png", siteBackground: "", backgroundColor: "#121212", ...Object.fromEntries(db.prepare('SELECT * FROM site_settings').all().map(r => [r.key, JSON.parse(r.value)])) });
  function audit(actor, action, target) { db.prepare('INSERT INTO admin_audit VALUES(?,?,?,?,?)').run(randomUUID(), actor, action, target, new Date().toISOString()); }
  function transaction(fn) { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } }
  const handler = async ({ path, req, url, auth, body, reply }) => {
    if (!path.startsWith('/v1/admin')) return false;
    const actor = auth();
    if (!isAdmin(actor)) throw fail(403, '需要管理员权限');
    const method = req.method, id = decodeURIComponent(path.split('/')[4] || '');
    const page = Math.max(1, Math.min(100000, Number(url.searchParams.get('page')) || 1)), limit = 30, offset = (page - 1) * limit;
    const list = table => ({ items: db.prepare(`SELECT * FROM ${table} ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(limit, offset), total: db.prepare(`SELECT count(*) n FROM ${table}`).get().n, page });
    if (path === '/v1/admin/overview' && method === 'GET') {
      reply({ actor: actor.username, counts: Object.fromEntries(['users','posts','comments','sessions'].map(t => [t, db.prepare(`SELECT count(*) n FROM ${t}`).get().n])), settings: settings() }); return true;
    }
    if (path === '/v1/admin/audit' && method === 'GET') { reply(list('admin_audit')); return true; }
    if (path === '/v1/admin/settings' && method === 'PATCH') {
      const b = await body(req);
      if (Object.entries(b).some(([k,v]) => {
        if (['registrationOpen','postingOpen'].includes(k)) return typeof v!=='boolean';
        if (k==='siteTitle') return typeof v!=='string'||!v.trim()||v.length>80;
        if (['siteIcon','siteBackground'].includes(k)) return !safeImage(v);
        if (k==='backgroundColor') return typeof v!=='string'||!/^#[0-9a-f]{6}$/i.test(v);
        return true;
      })) throw fail(400,'无效站点设置');
      transaction(() => { for (const [key, value] of Object.entries(b)) db.prepare('INSERT OR REPLACE INTO site_settings VALUES(?,?)').run(key,JSON.stringify(value)); audit(actor.id,'settings.update',JSON.stringify(b)); }); reply(settings()); return true;
    }
    if (path === '/v1/admin/users' && method === 'GET') {
      // Never SELECT password/salt into the response, even for administrators.
      const rows = db.prepare('SELECT id,username FROM users ORDER BY rowid DESC LIMIT ? OFFSET ?').all(limit, offset);
      reply({ items: rows.map(u => ({ ...u, ...profiles.get(u.id), role: isAdmin(u) ? 'admin' : 'user', banned: banned(u), sessions: db.prepare('SELECT count(*) n FROM sessions WHERE userId=? AND expires>?').get(u.id,Date.now()).n })), total: db.prepare('SELECT count(*) n FROM users').get().n, page }); return true;
    }
    if (/^\/v1\/admin\/users\/[^/]+$/.test(path) && method === 'PATCH') {
      const target = db.prepare('SELECT id,username FROM users WHERE id=?').get(id); if (!target) throw fail(404,'用户不存在');
      const b = await body(req);
      const profilePatch = Object.fromEntries(Object.entries(b).filter(([k])=>!['role','banned'].includes(k)));
      if (!validateProfile(profilePatch) || Object.keys(b).some(k => !['role','banned','nickname','bio','avatarUrl','level','exp','denny','polychrome','hidden'].includes(k)) || (b.role !== undefined && !['user','admin'].includes(b.role)) || (b.banned !== undefined && typeof b.banned !== 'boolean')) throw fail(400,'无效用户权限');
      if ((b.banned || b.role === 'user') && target.id === actor.id) throw fail(400,'不能封禁自己或移除自己的管理员权限');
      if ((b.banned || b.role === 'user') && bootstrap().has(target.username)) throw fail(400,'部署指定的管理员必须由部署者修改环境配置');
      transaction(() => { const old = access(target); db.prepare('INSERT OR REPLACE INTO user_access VALUES(?,?,?)').run(id,b.role ?? old.role,b.banned === undefined ? Number(old.banned) : Number(b.banned)); if (b.banned) db.prepare('DELETE FROM sessions WHERE userId=?').run(id); profiles.set(id,profilePatch); audit(actor.id,'user.update',JSON.stringify({id,changes:b})); }); reply({ ok:true }); return true;
    }
    if (/^\/v1\/admin\/users\/[^/]+\/sessions$/.test(path) && method === 'DELETE') {
      transaction(() => { db.prepare('DELETE FROM sessions WHERE userId=?').run(id); audit(actor.id,'sessions.revoke',id); }); reply({ok:true}); return true;
    }
    const type = path.split('/')[3];
    if (['posts','comments'].includes(type)) {
      if (path === `/v1/admin/${type}` && method === 'GET') { const result = list(type); result.items = result.items.map(r => ({ ...JSON.parse(r.data), id:r.id })); reply(result); return true; }
      const row = db.prepare(`SELECT * FROM ${type} WHERE id=?`).get(id); if (!row) throw fail(404,'内容不存在');
      if (method === 'PATCH') {
        const b = await body(req), allowed = type === 'posts' ? ['title','body','status'] : ['body'];
        if (Object.keys(b).some(k => !allowed.includes(k)) || (b.title !== undefined && (typeof b.title !== 'string' || !b.title.trim() || b.title.length>200)) || (b.body !== undefined && (typeof b.body !== 'string' || b.body.length>500000)) || (b.status !== undefined && !['draft','published'].includes(b.status))) throw fail(400,'无效内容字段');
        const data = { ...JSON.parse(row.data), ...b, updatedAt:new Date().toISOString() }; if (b.status === 'published' && !data.publishedAt) data.publishedAt = new Date().toISOString();
        transaction(() => { db.prepare(`UPDATE ${type} SET data=? WHERE id=?`).run(JSON.stringify(data),id); audit(actor.id,`${type}.update`,id); }); broadcast('content.updated',{id}); reply({ok:true}); return true;
      }
      if (method === 'DELETE') {
        transaction(() => {
          if (type === 'posts') { for (const c of db.prepare('SELECT id FROM comments WHERE postId=?').all(id)) db.prepare('DELETE FROM reactions WHERE targetId=?').run(c.id); db.prepare('DELETE FROM comments WHERE postId=?').run(id); }
          else { const children = db.prepare('SELECT id,data FROM comments WHERE postId=?').all(row.postId); const ids = new Set([id]); let changed = true; while(changed) { changed = false; for (const c of children) if (ids.has(JSON.parse(c.data).parentId) && !ids.has(c.id)) { ids.add(c.id); changed = true; } } for (const cid of ids) { db.prepare('DELETE FROM comments WHERE id=?').run(cid); db.prepare('DELETE FROM reactions WHERE targetId=?').run(cid); } }
          db.prepare(`DELETE FROM ${type} WHERE id=?`).run(id); db.prepare('DELETE FROM reactions WHERE targetId=?').run(id); audit(actor.id,`${type}.delete`,id);
        }); broadcast('content.deleted',{id}); reply({ok:true}); return true;
      }
    }
    throw fail(404,'后台接口不存在');
  };
  return { handler, isAdmin, banned, settings };
}
