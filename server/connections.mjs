import { randomBytes } from 'node:crypto';

// OAuth credentials never enter the SPA. Tokens are intentionally memory-only.
export function createConnections({ env = process.env, fetcher = fetch } = {}) {
  const states = new Map(), accounts = new Map();
  const configured = () => Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && /^https?:\/\//.test(env.GITHUB_REDIRECT_URI || ''));
  const error = (status, message) => Object.assign(new Error(message), { status });
  const jsonFetch = async (url, options = {}) => {
    const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw error(502, '平台请求失败或授权已失效，请重新连接');
    return response.json();
  };
  const api = (path, token) => jsonFetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'InterKnot-SelfHosted' },
  });
  return async ({ path, req, res, url, auth, reply }) => {
    if (!path.startsWith('/v1/connections')) return false;
    if (path === '/v1/connections' && req.method === 'GET') {
      const user = auth();
      reply({ providers: [
        { id: 'github', name: 'GitHub', configured: configured(), connected: accounts.has(user.id), note: '授权后读取资料、公开仓库与公开活动；不读取全部私有信息。重启服务需重新授权。' },
        { id: 'bilibili', name: 'bilibili', configured: false, connected: false, note: '账号授权尚未接入；支持手动添加 BV 视频并尝试官方嵌入播放。' },
        { id: 'douyin', name: '抖音', configured: false, connected: false, note: '待开放平台应用审核及授权接口接入；暂不支持账号读取和站内播放。' },
      ] });
      return true;
    }
    if (path === '/v1/connections/github/start' && req.method === 'GET') {
      const user = auth();
      if (!configured()) throw error(503, '需先配置 GitHub OAuth 应用 Client ID、Secret 与回调地址');
      for (const [key, value] of states) if (value.expires < Date.now()) states.delete(key);
      if (states.size > 1000) throw error(429, '请稍后重试');
      const state = randomBytes(32).toString('hex');
      states.set(state, { userId: user.id, expires: Date.now() + 600000 });
      const target = new URL('https://github.com/login/oauth/authorize');
      target.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: env.GITHUB_REDIRECT_URI, scope: 'read:user', state }).toString();
      res.writeHead(302, { location: target.href, 'cache-control': 'no-store' }); res.end();
      return true;
    }
    if (path === '/v1/connections/github/callback' && req.method === 'GET') {
      const user = auth(), state = url.searchParams.get('state'), pending = states.get(state);
      states.delete(state);
      if (!pending || pending.userId !== user.id || pending.expires < Date.now()) throw error(400, '授权校验失败或已过期，请重试');
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.has('error')) throw error(400, '授权已取消');
      const result = await jsonFetch('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, redirect_uri: env.GITHUB_REDIRECT_URI, code }),
      });
      if (!result.access_token) throw error(502, '平台未返回有效授权');
      accounts.set(user.id, result.access_token);
      res.writeHead(302, { location: '/connections', 'cache-control': 'no-store' }); res.end(); return true;
    }
    if (path === '/v1/connections/github' && req.method === 'DELETE') {
      accounts.delete(auth().id); reply({ ok: true }); return true;
    }
    if (path === '/v1/connections/github/content' && req.method === 'GET') {
      const token = accounts.get(auth().id);
      if (!token) throw error(409, '请先连接 GitHub');
      const profile = await api('/user', token);
      const [repos, events] = await Promise.all([
        api('/user/repos?visibility=public&sort=updated&per_page=30', token),
        api(`/users/${encodeURIComponent(profile.login)}/events/public?per_page=30`, token),
      ]);
      reply({ profile: { login: profile.login, name: profile.name, bio: profile.bio, avatar: profile.avatar_url, followers: profile.followers, following: profile.following },
        repos: repos.map(r => ({ id: r.id, name: r.full_name, description: r.description, stars: r.stargazers_count, language: r.language })),
        events: events.map(e => ({ id: e.id, type: e.type, repo: e.repo?.name, createdAt: e.created_at })),
      }); return true;
    }
    throw error(404, '未实现的平台接口');
  };
}
