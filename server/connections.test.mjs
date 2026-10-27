import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnections } from './connections.mjs';
const env = { GITHUB_CLIENT_ID: 'test-id', GITHUB_CLIENT_SECRET: 'test-secret', GITHUB_REDIRECT_URI: 'https://example.test/v1/connections/github/callback' };
function call(handler, path, options = {}) {
  let payload, status, headers;
  return handler({ path, url: new URL(path + (options.query || ''), 'https://example.test'), req: { method: options.method || 'GET' }, auth: () => ({ id: options.user || 'local-user' }), reply: data => { payload = data; }, res: { writeHead: (s, h) => { status = s; headers = h; }, end() {} } }).then(handled => ({ handled, payload, status, headers }));
}
test('honestly reports unconfigured providers and refuses OAuth start', async () => {
  const h = createConnections({ env: {} });
  const result = await call(h, '/v1/connections');
  assert.equal(result.payload.providers.every(p => !p.connected && !p.configured), true);
  await assert.rejects(call(h, '/v1/connections/github/start'), { status: 503 });
});
test('OAuth state is user-bound, single-use; data and tokens are isolated', async () => {
  const calls = [];
  const h = createConnections({ env, fetcher: async (url, options) => {
    calls.push({ url, options });
    const data = url.includes('access_token') ? { access_token: 'secret-access-token' } : url.endsWith('/user') ? { login: 'tester', name: 'Test' } : url.includes('/user/repos') ? [{ id: 1, full_name: 'tester/repo', private: false }] : [{ id: 'event', type: 'PushEvent', repo: { name: 'tester/repo' } }];
    return { ok: true, json: async () => data };
  } });
  const start = await call(h, '/v1/connections/github/start');
  assert.equal(start.status, 302);
  const state = new URL(start.headers.location).searchParams.get('state');
  await assert.rejects(call(h, '/v1/connections/github/callback', { user: 'other', query: `?state=${state}&code=test` }), { status: 400 });
  const second = await call(h, '/v1/connections/github/start');
  const validState = new URL(second.headers.location).searchParams.get('state');
  await call(h, '/v1/connections/github/callback', { query: `?state=${validState}&code=test` });
  await assert.rejects(call(h, '/v1/connections/github/callback', { query: `?state=${validState}&code=test` }), { status: 400 });
  const content = await call(h, '/v1/connections/github/content');
  assert.equal(content.payload.profile.login, 'tester');
  assert.equal(content.payload.repos[0].name, 'tester/repo');
  assert.equal(JSON.stringify(content).includes('secret-access-token'), false);
  await assert.rejects(call(h, '/v1/connections/github/content', { user: 'other' }), { status: 409 });
  await call(h, '/v1/connections/github', { method: 'DELETE' });
  await assert.rejects(call(h, '/v1/connections/github/content'), { status: 409 });
  assert.equal(calls.length, 4);
});
