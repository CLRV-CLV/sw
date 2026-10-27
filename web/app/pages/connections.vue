<script setup lang="ts">
const auth = useAuthStore();
const login = useLoginDialog();
interface Provider { id: string; name: string; configured: boolean; connected: boolean; note: string }
interface GithubContent { profile: { login: string; name: string; bio: string; avatar: string; followers: number; following: number }; repos: { id: number; name: string; description: string; stars: number; language: string }[]; events: { id: string; type: string; repo: string; createdAt: string }[] }
const providers = ref<Provider[]>([]), github = ref<GithubContent | null>(null);
const error = ref(''), loading = ref(false), videoInput = ref(''), videos = ref<string[]>([]), playing = ref('');
async function load() {
  error.value = ''; loading.value = true;
  try { providers.value = (await $fetch<{ providers: Provider[] }>('/v1/connections')).providers;
    github.value = providers.value.some(p => p.id === 'github' && p.connected) ? await $fetch<GithubContent>('/v1/connections/github/content') : null;
  } catch { error.value = '读取失败：请确认已登录本站、平台授权有效，且服务器可访问平台接口。'; }
  finally { loading.value = false; }
}
async function disconnect() {
  try { await $fetch('/v1/connections/github', { method: 'DELETE' }); await load(); }
  catch { error.value = '断开失败，请重试'; }
}
function addVideo() {
  // Accept only a BV id or an explicit official video URL, never arbitrary frames.
  const value = videoInput.value.trim();
  const id = /^BV[0-9A-Za-z]{10}$/.test(value) ? value : /^https:\/\/(?:www\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{10})(?:[/?#].*)?$/.exec(value)?.[1];
  if (!id) { error.value = '请输入 BV 号或 https://www.bilibili.com/video/BV… 完整链接；不支持短链接。'; return; }
  videos.value = [...new Set([...videos.value, id])].slice(-50);
  localStorage.setItem('ik-video-bookmarks', JSON.stringify(videos.value)); videoInput.value = ''; error.value = '';
}
function removeVideo(id: string) { videos.value = videos.value.filter(v => v !== id); localStorage.setItem('ik-video-bookmarks', JSON.stringify(videos.value)); if (playing.value === id) playing.value = ''; }
onMounted(() => { try { const saved = JSON.parse(localStorage.getItem('ik-video-bookmarks') || '[]'); videos.value = Array.isArray(saved) ? saved.filter(v => typeof v === 'string' && /^BV[0-9A-Za-z]{10}$/.test(v)).slice(-50) : []; } catch { /* Ignore invalid local preferences. */ } if (auth.isLogin) load(); });
watch(() => auth.isLogin, logged => { if (logged) load(); else { providers.value = []; github.value = null; } });
</script>

<template>
  <section class="connections">
    <header><small>FAIRY / CONNECTED ACCOUNTS</small><h1>跨平台内容中枢</h1><p>授权读取 · 远程展示 · 不保存视频文件</p><NuxtLink to="/account">← 返回账号设置</NuxtLink></header>
    <p class="notice">本站账号独立使用，无需 GitHub。连接第三方时仍需在平台官方页面登录授权。仅可读取获准的数据，不包含密码、全部私信或所有账号信息。</p>
    <button v-if="!auth.isLogin" @click="login.open()">先登录本站，再连接平台</button>
    <template v-else>
      <button :disabled="loading" @click="load">{{ loading ? '读取中…' : '刷新授权内容' }}</button>
      <p v-if="error" role="alert">{{ error }}</p>
      <div class="providers"><article v-for="p in providers" :key="p.id"><h2>{{ p.name }}</h2><b>{{ p.connected ? '已授权' : p.configured ? '可连接' : '待接入 / 配置' }}</b><p>{{ p.note }}</p><a v-if="p.id === 'github' && p.configured && !p.connected" href="/v1/connections/github/start">前往 GitHub 官方授权</a><button v-if="p.connected" @click="disconnect">断开本站连接</button></article></div>
      <article v-if="github"><h2>{{ github.profile.name || github.profile.login }} / {{ github.profile.login }}</h2><p>{{ github.profile.bio }}</p><p>关注 {{ github.profile.following }} · 关注者 {{ github.profile.followers }}</p><h3>公开仓库（最近更新 30 个以内）</h3><div class="repos"><section v-for="repo in github.repos" :key="repo.id"><b>{{ repo.name }}</b><p>{{ repo.description }}</p><small>{{ repo.language }} · ★ {{ repo.stars }}</small></section></div><h3>公开活动</h3><p v-for="event in github.events" :key="event.id">{{ event.type }} · {{ event.repo }} · {{ event.createdAt }}</p></article>
    </template>
    <article><h2>bilibili · 站内播放器</h2><p>手动收藏视频链接，不等于已登录或自动导入账号内容。播放使用官方远程播放器，能否播放取决于平台的嵌入、地域、版权及登录限制。</p><form @submit.prevent="addVideo"><input v-model="videoInput" aria-label="BV号或bilibili视频地址" placeholder="BV号 / bilibili 完整视频链接" maxlength="500"><button>添加链接</button></form><p v-if="error && !auth.isLogin" role="alert">{{ error }}</p><div v-for="id in videos" :key="id" class="video"><button @click="playing = id">▶ 在本站播放 {{ id }}</button><button @click="removeVideo(id)">移除</button></div><template v-if="playing"><iframe :key="playing" :src="`https://player.bilibili.com/player.html?bvid=${playing}&autoplay=0`" title="bilibili 官方视频播放器" allow="fullscreen; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" /><button @click="playing = ''">关闭播放器</button><p>如播放器拒绝加载，本页不会下载、解析受限视频或自动跳转；目前无法保证所有视频均可站内播放。</p></template></article>
  </section>
</template>

<style scoped>
.connections{max-width:1400px;margin:auto;padding:28px 20px 110px;color:#ddd}.connections h1{font-size:36px;color:#d7fa00}.connections header small{letter-spacing:3px}.notice{border-left:4px solid #d7fa00;padding:14px;background:#242820}.providers,.repos{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}.connections article{padding:22px;background:#202220;border:2px solid #3c4038;border-radius:22px;margin:18px 0}.connections article p{line-height:1.7;color:#b7bdb2}.connections a{color:#d7fa00}.connections button{padding:10px 16px;border-radius:999px;border:1px solid #59614b;background:#d7fa00;color:#14180b;cursor:pointer;font-weight:700}.connections button:disabled{opacity:.5}.connections input{padding:12px;background:#111;color:white;border:1px solid #555;border-radius:999px;width:min(100%,460px);box-sizing:border-box}.connections form{display:flex;flex-wrap:wrap;gap:10px}.repos section{padding:12px;background:#141614;border-radius:12px;overflow-wrap:anywhere}.video{display:flex;gap:10px;margin:12px 0}.connections iframe{width:100%;aspect-ratio:16/9;border:0;background:black}.connections [role=alert]{color:#ffb394}
</style>
