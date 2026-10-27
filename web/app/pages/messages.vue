<script setup lang="ts">
interface Peer {
  id: string;
  name: string;
  avatarUrl: string;
  level: number;
}
interface Entry {
  key: string;
  conversationId: string;
  conversationKind: "direct" | "group" | "channel";
  ownerId?: string;
  memberCount?: number;
  peer: Peer;
  unreadCount: number;
  muted: boolean;
  pinned: boolean;
  preview?: { text: string };
}
interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  sender?: Peer;
  attachment?: {
    url: string;
    type: "file" | "image" | "audio";
    name: string;
    size: number;
  };
  content: string;
  createdAt: string;
  editedAt?: string;
  withdrawnAt?: string;
  replyTo?: { id: string; content: string; withdrawn: boolean };
}
interface Friend {
  peerId: string;
  accepted: number;
  remark: string;
  groupName: string;
  blocked: number;
  user: Peer;
}
interface Request {
  id: string;
  user: Peer;
}
interface Group {
  id: string;
  title: string;
  ownerId: string;
  members: Peer[];
}
const aiMode=ref(useRoute().query.tab==='ai');
const auth = useAuthStore(),
  login = useLoginDialog(),
  rt = useRealtime();
const entries = ref<Entry[]>([]),
  contacts = ref<Peer[]>([]),
  selected = ref(""),
  items = ref<Message[]>([]),
  query = ref(""),
  content = ref(""),
  error = ref(""),
  busy = ref(false),
  quoting = ref<Message | null>(null),
  cursor = ref<string | null>(null),
  pendingId = ref<string | null>(null);
const friends = ref<Friend[]>([]),
  requests = ref<Request[]>([]),
  groupInfo = ref<Group | null>(null),
  groupPanel = ref(false),
  groupTitle = ref(""),
  groupIds = ref<string[]>([]),
  groupBusy = ref(false);
const searchTerm = ref(""),
  searching = ref(false),
  searchResults = ref<Message[]>([]),
  searchCursor = ref<string | null>(null),
  inboxCursor = ref<string | null>(null);
const timelineBox = ref<HTMLElement | null>(null),
  notice = ref("");
const active = computed(() =>
  entries.value.find((c) => c.conversationId === selected.value),
);
const me = computed(() => String(auth.user?.id || ""));
const groupMode = ref<"group" | "channel">("group"),
  pinnedMessages = ref<Message[]>([]);
const groupOwner = computed(() => groupInfo.value?.ownerId === me.value);
const visibleMessages = computed(() =>
  searching.value ? searchResults.value : items.value,
);
function err(e: unknown) {
  return (
    (e as { data?: { detail?: string } }).data?.detail || "连接失败，请重试"
  );
}
async function refresh(older = false) {
  if (!auth.isLogin) return;
  try {
    const r = await $fetch<{ items: Entry[]; nextCursor: string | null }>(
      "/v1/inbox",
      {
        query: {
          limit: 50,
          ...(older && inboxCursor.value ? { cursor: inboxCursor.value } : {}),
        },
      },
    );
    const previous = active.value;
    entries.value = older
      ? [
          ...entries.value,
          ...r.items.filter((c) => !entries.value.some((e) => e.key === c.key)),
        ]
      : r.items;
    if (
      !older &&
      previous &&
      !entries.value.some((e) => e.key === previous.key)
    ) {
      try {
        const c = await $fetch<{
          kind: "direct" | "group" | "channel";
          peer: Peer;
          unreadCount: number;
          muted: boolean;
          pinned: boolean;
        }>(`/v1/dm/conversations/${previous.conversationId}`);
        if (selected.value === previous.conversationId)
          entries.value.push({ ...previous, ...c, conversationKind: c.kind });
      } catch {
        closeConversation(previous.conversationId);
      }
    }
    inboxCursor.value = r.nextCursor;
  } catch (e) {
    error.value = err(e);
  }
}
async function relationships() {
  try {
    const [f, r] = await Promise.all([
      $fetch<{ items: Friend[] }>("/v1/dm/friends"),
      $fetch<{ items: Request[] }>("/v1/dm/friend-requests"),
    ]);
    friends.value = f.items;
    requests.value = r.items;
  } catch (e) {
    error.value = err(e);
  }
}
async function search() {
  try {
    contacts.value = (
      await $fetch<{ items: Peer[] }>("/v1/dm/contacts", {
        query: { q: query.value },
      })
    ).items;
  } catch (e) {
    error.value = err(e);
  }
}
async function loadGroup() {
  const id = selected.value;
  if (!active.value || active.value.conversationKind === "direct") {
    groupInfo.value = null;
    return;
  }
  try {
    const g = await $fetch<Group>(`/v1/dm/groups/${id}`);
    if (selected.value === id) groupInfo.value = g;
  } catch (e) {
    error.value = err(e);
  }
}
async function timeline(older = false) {
  const id = selected.value;
  if (!id) return;
  try {
    const r = await $fetch<{
      items: { type: string; message: Message }[];
      nextCursor: string | null;
    }>(`/v1/inbox/dm-${id}/items`, {
      query: older && cursor.value ? { cursor: cursor.value } : {},
    });
    if (selected.value !== id) return;
    const list = r.items.map((i) => i.message).reverse();
    const box = timelineBox.value,
      nearBottom =
        !box || box.scrollHeight - box.scrollTop - box.clientHeight < 100;
    items.value = older ? [...list, ...items.value] : list;
    cursor.value = r.nextCursor;
    await nextTick();
    if (!older && nearBottom && timelineBox.value)
      timelineBox.value.scrollTop = timelineBox.value.scrollHeight;
    await $fetch(`/v1/inbox/dm-${id}/read`, { method: "POST" });
    await refresh();
  } catch (e) {
    error.value = err(e);
  }
}
async function choose(id: string) {
  if (busy.value || recording.value) return;
  content.value = "";
  pendingId.value = null;
  selected.value = id;
  items.value = [];
  quoting.value = null;
  groupInfo.value = null;
  searching.value = false;
  searchResults.value = [];
  searchTerm.value = "";
  pinnedMessages.value = [];
  await Promise.all([timeline(), loadGroup(), loadPins()]);
}
async function start(p: Peer) {
  try {
    const c = await $fetch<{ id: string }>("/v1/dm/direct", {
      method: "POST",
      body: { userId: p.id },
    });
    await refresh();
    await choose(c.id);
  } catch (e) {
    error.value = err(e);
  }
}
async function send() {
  if (busy.value || !content.value.trim() || !selected.value) return;
  busy.value = true;
  error.value = "";
  pendingId.value ||= crypto.randomUUID();
  const id = selected.value;
  try {
    await $fetch(`/v1/dm/conversations/${id}/messages`, {
      method: "POST",
      body: {
        content: content.value,
        clientId: pendingId.value,
        replyToId: quoting.value?.id,
      },
    });
    content.value = "";
    pendingId.value = null;
    quoting.value = null;
    if (selected.value === id) await timeline();
  } catch (e) {
    error.value = err(e);
  } finally {
    busy.value = false;
  }
}
const recording = ref(false),
  fileInput = ref<HTMLInputElement | null>(null);
let disposed = false;
let recorder: MediaRecorder | null = null,
  recordStream: MediaStream | null = null,
  recordTimer: ReturnType<typeof setTimeout> | null = null;
function stopRecording() {
  if (recorder?.state === "recording") recorder.stop();
  recordStream?.getTracks().forEach((t) => t.stop());
  recordStream = null;
  if (recordTimer) clearTimeout(recordTimer);
  recordTimer = null;
  recording.value = false;
}
async function upload(file: File, id = selected.value) {
  if (busy.value || !id) return;
  busy.value = true;
  error.value = "";
  try {
    if (file.size > 5 * 1048576) throw Error("文件最多5MB");
    const data = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] || "");
      r.onerror = () => reject(Error("读取文件失败"));
      r.readAsDataURL(file);
    });
    await $fetch(`/v1/dm/conversations/${id}/messages`, {
      method: "POST",
      body: {
        content: file.name,
        clientId: crypto.randomUUID(),
        attachment: {
          name: file.name,
          mime: file.type.split(";")[0] || "application/octet-stream",
          data,
        },
      },
    });
    if (selected.value === id) await timeline();
  } catch (e) {
    error.value =
      (e as Error).message === "文件最多5MB" ? "文件最多5MB" : err(e);
  } finally {
    busy.value = false;
    if (fileInput.value) fileInput.value.value = "";
  }
}
function fileChosen(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) upload(file);
}
async function record() {
  if (recording.value) {
    stopRecording();
    return;
  }
  if (
    !navigator.mediaDevices?.getUserMedia ||
    typeof MediaRecorder === "undefined"
  ) {
    error.value = "此浏览器不支持录音，请使用HTTPS及支持录音的浏览器";
    return;
  }
  try {
    const recordingId = selected.value;
    recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (disposed || !auth.isLogin || selected.value !== recordingId) {
      stopRecording();
      return;
    }
    const chunks: Blob[] = [];
    recorder = new MediaRecorder(recordStream);
    const currentRecorder = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onstop = () => {
      const type = currentRecorder.mimeType || "audio/webm";
      stopRecording();
      const blob = new Blob(chunks, { type });
      if (blob.size)
        upload(
          new File(
            [blob],
            `语音-${Date.now()}.${type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm"}`,
            { type },
          ),
          recordingId,
        );
    };
    recorder.start();
    recording.value = true;
    recordTimer = setTimeout(stopRecording, 60000);
  } catch {
    stopRecording();
    error.value = "无法录音，请检查麦克风授权与HTTPS连接";
  }
}
async function change(m: Message, withdraw = false) {
  if (withdraw && !confirm("撤回这条消息？")) return;
  const value = withdraw ? null : prompt("编辑消息", m.content);
  if (!withdraw && value === null) return;
  try {
    await $fetch(`/v1/dm/messages/${m.id}`, {
      method: withdraw ? "DELETE" : "PATCH",
      ...(withdraw ? {} : { body: { content: value } }),
    });
    await timeline();
    if (searching.value) await searchMessages();
  } catch (e) {
    error.value = err(e);
  }
}
async function preference(key: "muted" | "pinned") {
  if (!active.value) return;
  try {
    await $fetch(`/v1/dm/conversations/${selected.value}`, {
      method: "PATCH",
      body: { [key]: !active.value[key] },
    });
    await refresh();
  } catch (e) {
    error.value = err(e);
  }
}
async function requestFriend(p: Peer) {
  try {
    await $fetch("/v1/dm/friend-requests", {
      method: "POST",
      body: { userId: p.id },
    });
    notice.value = "好友申请已发送";
  } catch (e) {
    error.value = err(e);
  }
}
async function respond(r: Request, accept: boolean) {
  try {
    await $fetch(
      `/v1/dm/friend-requests/${r.id}/${accept ? "accept" : "reject"}`,
      { method: "POST" },
    );
    await relationships();
  } catch (e) {
    error.value = err(e);
  }
}
async function friendSettings(p: Peer, body: object) {
  try {
    await $fetch(`/v1/dm/friends/${p.id}`, { method: "PATCH", body });
    await relationships();
  } catch (e) {
    error.value = err(e);
  }
}
async function remark(f: Friend) {
  const value = prompt("好友备注（最多40字）", f.remark);
  if (value !== null) await friendSettings(f.user, { remark: value });
}
async function moveFriend(f: Friend) {
  const value = prompt("好友分组（最多40字，留空移出分组）", f.groupName);
  if (value !== null) await friendSettings(f.user, { groupName: value });
}
async function deleteFriend(f: Friend) {
  if (!confirm("删除好友？双方已有聊天记录会保留。")) return;
  try {
    await $fetch(`/v1/dm/friends/${f.peerId}`, { method: "DELETE" });
    await relationships();
  } catch (e) {
    error.value = err(e);
  }
}
async function createGroup() {
  if (groupBusy.value) return;
  groupBusy.value = true;
  try {
    const g = await $fetch<{ id: string }>("/v1/dm/groups", {
      method: "POST",
      body: {
        title: groupTitle.value,
        userIds: groupIds.value,
        mode: groupMode.value,
      },
    });
    groupPanel.value = false;
    groupTitle.value = "";
    groupIds.value = [];
    await refresh();
    await choose(g.id);
  } catch (e) {
    error.value = err(e);
  } finally {
    groupBusy.value = false;
  }
}
async function groupChange(body: object) {
  try {
    await $fetch(`/v1/dm/groups/${selected.value}`, { method: "PATCH", body });
    await refresh();
    await loadGroup();
  } catch (e) {
    error.value = err(e);
  }
}
async function renameGroup() {
  const title = prompt("群名称", groupInfo.value?.title);
  if (title !== null) await groupChange({ title });
}
async function invite(p: Peer) {
  try {
    await $fetch(`/v1/dm/groups/${selected.value}/members`, {
      method: "POST",
      body: { userId: p.id },
    });
    await loadGroup();
    await refresh();
  } catch (e) {
    error.value = err(e);
  }
}
async function removeMember(p: Peer) {
  if (
    !confirm(
      p.id === me.value
        ? "退出群聊后将失去聊天记录访问权限，确定？"
        : `移出 ${p.name}？`,
    )
  )
    return;
  const id = selected.value;
  try {
    await $fetch(`/v1/dm/groups/${id}/members/${p.id}`, { method: "DELETE" });
    if (p.id === me.value) closeConversation(id);
    else await loadGroup();
    await refresh();
  } catch (e) {
    error.value = err(e);
  }
}
async function transfer(p: Peer) {
  if (confirm(`将群主转让给 ${p.name}？`)) await groupChange({ ownerId: p.id });
}
async function dissolve() {
  if (!confirm("解散群聊并删除本群全部消息？不可恢复。")) return;
  const id = selected.value;
  try {
    await $fetch(`/v1/dm/groups/${id}`, { method: "DELETE" });
    closeConversation(id);
    await refresh();
  } catch (e) {
    error.value = err(e);
  }
}
function closeConversation(id: string) {
  entries.value = entries.value.filter((e) => e.conversationId !== id);
  if (selected.value === id) {
    selected.value = "";
    items.value = [];
    searchResults.value = [];
    groupInfo.value = null;
    quoting.value = null;
  }
}
async function loadPins() {
  const id = selected.value;
  if (!id) return;
  try {
    const r = await $fetch<{ items: Message[] }>(
      `/v1/dm/conversations/${id}/pins`,
    );
    if (id === selected.value) pinnedMessages.value = r.items;
  } catch (e) {
    error.value = err(e);
  }
}
async function pinMessage(m: Message, remove = false) {
  try {
    await $fetch(`/v1/dm/messages/${m.id}/pin`, {
      method: remove ? "DELETE" : "PUT",
    });
    await loadPins();
  } catch (e) {
    error.value = err(e);
  }
}
async function searchMessages(older = false) {
  const id = selected.value;
  if (!id || !searchTerm.value.trim()) return;
  try {
    const r = await $fetch<{ items: Message[]; nextCursor: string | null }>(
      `/v1/dm/conversations/${id}/search`,
      {
        query: {
          q: searchTerm.value,
          ...(older && searchCursor.value
            ? { cursor: searchCursor.value }
            : {}),
        },
      },
    );
    if (selected.value !== id) return;
    searching.value = true;
    searchResults.value = older
      ? [...searchResults.value, ...r.items]
      : r.items;
    searchCursor.value = r.nextCursor;
  } catch (e) {
    error.value = err(e);
  }
}
let off: (() => void) | undefined;
onMounted(() => {
  if (auth.isLogin) {
    refresh();
    search();
    relationships();
  }
  off = rt.on("*", (event) => {
    const id = (event.d as { conversationId?: string })?.conversationId;
    if (event.t === "dm.conversation.left" && id) {
      closeConversation(id);
      refresh();
      return;
    }
    if (["dm.friend.requested", "dm.friends.updated"].includes(event.t)) {
      relationships();
      return;
    }
    if (
      [
        "dm.message.created",
        "dm.message.edited",
        "dm.message.withdrawn",
        "dm.conversation.updated",
        "dm.conversation.created",
        "dm.message.pinned",
      ].includes(event.t)
    ) {
      refresh();
      if (id === selected.value) {
        loadPins();
        if (event.t.startsWith("dm.message.")) {
          timeline();
          if (searching.value) searchMessages();
        } else loadGroup();
      }
    }
  });
});
onBeforeUnmount(() => {
  disposed = true;
  off?.();
  if (recorder) recorder.onstop = null;
  stopRecording();
});
watch(
  () => auth.isLogin,
  (v) => {
    if (!v) {
      if (recorder) recorder.onstop = null;
      stopRecording();
    }
    entries.value = [];
    items.value = [];
    contacts.value = [];
    selected.value = "";
    friends.value = [];
    requests.value = [];
    groupInfo.value = null;
    searchResults.value = [];
    content.value = "";
    pendingId.value = null;
    if (v) {
      refresh();
      search();
      relationships();
    }
  },
);
</script>
<template>
  <section class="messages">
    <header>
      <small>KNOCK KNOCK / PRIVATE CHANNEL</small>
      <h1>敲敲</h1>
      <p>私聊 / 群聊 · 好友 · 聊天记录搜索</p>
    </header>
    <button v-if="!auth.isLogin" @click="login.open()">登录后使用敲敲</button>
    <p v-if="error" role="alert">
      {{ error }} <button @click="error = ''">关闭提示</button>
    </p>
    <p v-if="notice" role="status">
      {{ notice }} <button @click="notice = ''">关闭提示</button>
    </p>
    <nav v-if="auth.isLogin" class="message-modes"><button :aria-pressed="!aiMode" @click="aiMode=false">联系人 / 群聊</button><button :aria-pressed="aiMode" @click="aiMode=true">驻站角色AI</button></nav><ResidentAIChat v-if="auth.isLogin&&aiMode"/><div v-if="auth.isLogin&&!aiMode" class="workspace">
      <aside>
        <h2>通讯录</h2>
        <form @submit.prevent="search">
          <input
            v-model="query"
            aria-label="搜索用户"
            placeholder="账号或昵称"
          /><button>查找</button>
        </form>
        <div class="contact-list">
          <div v-for="p in contacts" :key="p.id" class="contact">
            <button @click="start(p)">
              <img :src="p.avatarUrl" alt="" />{{ p.name
              }}<small>Lv.{{ p.level }}</small></button
            ><button
              @click="requestFriend(p)"
              :aria-label="`添加 ${p.name} 为好友`"
            >
              ＋好友</button
            ><button
              @click="friendSettings(p, { blocked: true })"
              :aria-label="`屏蔽 ${p.name}`"
            >
              屏蔽
            </button>
          </div>
        </div>
        <details>
          <summary>好友 / 申请 / 黑名单</summary>
          <h3>好友申请</h3>
          <div v-for="r in requests" :key="r.id">
            <b>{{ r.user.name }}</b
            ><button @click="respond(r, true)">接受</button
            ><button @click="respond(r, false)">拒绝</button>
          </div>
          <p v-if="!requests.length">暂无待处理申请</p>
          <h3>好友列表</h3>
          <div
            v-for="f in friends.filter((f) => f.accepted && !f.blocked)"
            :key="f.peerId"
            class="friend"
          >
            <button @click="start(f.user)">{{ f.remark || f.user.name }}</button
            ><small>{{ f.groupName || "未分组" }}</small
            ><button @click="remark(f)">备注</button
            ><button @click="moveFriend(f)">分组</button
            ><button @click="deleteFriend(f)">删除</button
            ><button @click="friendSettings(f.user, { blocked: true })">
              加入黑名单
            </button>
          </div>
          <h3>黑名单</h3>
          <div v-for="f in friends.filter((f) => f.blocked)" :key="f.peerId">
            {{ f.user.name
            }}<button @click="friendSettings(f.user, { blocked: false })">
              解除屏蔽
            </button>
          </div>
        </details>
        <button @click="groupPanel = !groupPanel">
          {{ groupPanel ? "取消建群" : "新建群聊" }}
        </button>
        <form
          v-if="groupPanel"
          class="group-form"
          @submit.prevent="createGroup"
        >
          <label
            >群名称<input v-model="groupTitle" maxlength="80" required /></label
          ><label
            >会话类型<select v-model="groupMode">
              <option value="group">群聊（成员均可发言）</option>
              <option value="channel">频道（仅群主发布）</option>
            </select></label
          >
          <p>选择通讯录中的成员（最多99人）</p>
          <label v-for="p in contacts" :key="p.id"
            ><input v-model="groupIds" type="checkbox" :value="p.id" />{{
              p.name
            }}</label
          ><button
            :disabled="groupBusy || !groupIds.length || !groupTitle.trim()"
          >
            创建群聊
          </button>
        </form>
        <h2>最近会话</h2>
        <button @click="refresh()">刷新会话</button>
        <button
          v-for="c in entries"
          :key="c.key"
          class="conversation"
          :aria-pressed="selected === c.conversationId"
          @click="choose(c.conversationId)"
        >
          <b
            >{{ c.pinned ? "⌖ " : ""
            }}{{
              c.conversationKind === "channel"
                ? "[频道] "
                : c.conversationKind === "group"
                  ? "[群] "
                  : ""
            }}{{ c.peer.name }}</b
          ><span>{{ c.preview?.text }}</span
          ><small
            >{{ c.unreadCount ? `${c.unreadCount} 未读` : "已读" }}
            {{ c.muted ? "· 免打扰" : "" }}</small
          >
        </button>
        <button v-if="inboxCursor" @click="refresh(true)">更多会话</button>
      </aside>
      <article>
        <template v-if="active">
          <header>
            <h2>{{ active.peer.name }}</h2>
            <button @click="preference('pinned')">
              {{ active.pinned ? "取消置顶" : "置顶" }}</button
            ><button @click="preference('muted')">
              {{ active.muted ? "取消免打扰" : "免打扰" }}</button
            ><NuxtLink
              v-if="active.conversationKind === 'direct'"
              :to="`/profile/${active.peer.id}`"
              >个人空间</NuxtLink
            >
          </header>
          <details v-if="groupInfo" class="group-info">
            <summary>群成员与管理 · {{ groupInfo.members.length }} 人</summary>
            <p>
              新加入的成员只能读取加入后的消息；群主可邀请、移除、转让和解散。
            </p>
            <button v-if="groupOwner" @click="renameGroup">修改群名</button
            ><button v-if="groupOwner" @click="dissolve">解散群聊</button>
            <div v-for="p in groupInfo.members" :key="p.id">
              <NuxtLink :to="`/profile/${p.id}`">{{ p.name }}</NuxtLink
              ><small>{{ p.id === groupInfo.ownerId ? " · 群主" : "" }}</small
              ><button
                v-if="p.id === me && p.id !== groupInfo.ownerId"
                @click="removeMember(p)"
              >
                退出群聊</button
              ><template v-if="groupOwner && p.id !== me"
                ><button @click="removeMember(p)">移出</button
                ><button @click="transfer(p)">转让群主</button></template
              >
            </div>
            <div v-if="groupOwner">
              <h3>邀请成员</h3>
              <button
                v-for="p in contacts.filter(
                  (p) => !groupInfo?.members.some((m) => m.id === p.id),
                )"
                :key="p.id"
                @click="invite(p)"
              >
                邀请 {{ p.name }}
              </button>
            </div>
          </details>
          <details v-if="pinnedMessages.length" class="pinned-messages">
            <summary>置顶消息 · {{ pinnedMessages.length }}</summary>
            <blockquote v-for="m in pinnedMessages" :key="m.id">
              <small>{{ m.sender?.name }}</small>
              <p>{{ m.content }}</p>
              <button
                v-if="active.conversationKind === 'direct' || groupOwner"
                @click="pinMessage(m, true)"
              >
                取消消息置顶
              </button>
            </blockquote>
          </details>
          <p v-if="active.conversationKind === 'channel' && !groupOwner">
            本频道仅群主可发布消息。
          </p>
          <form class="history-search" @submit.prevent="searchMessages()">
            <input
              v-model="searchTerm"
              aria-label="搜索聊天记录"
              maxlength="100"
              placeholder="搜索本会话消息"
            /><button>搜索记录</button
            ><button v-if="searching" type="button" @click="searching = false">
              返回聊天
            </button>
          </form>
          <button v-if="!searching && cursor" @click="timeline(true)">
            加载更早消息</button
          ><button
            v-if="searching && searchCursor"
            @click="searchMessages(true)"
          >
            更多搜索结果
          </button>
          <div ref="timelineBox" class="timeline" aria-live="polite">
            <div
              v-for="m in visibleMessages"
              :key="m.id"
              class="bubble"
              :class="{ mine: m.senderId === me }"
            >
              <small
                >{{
                  m.senderId === me ? "我" : m.sender?.name || active.peer.name
                }}
                · {{ m.createdAt }} {{ m.editedAt ? "· 已编辑" : "" }}</small
              >
              <blockquote v-if="m.replyTo">
                {{ m.replyTo.withdrawn ? "引用消息已撤回" : m.replyTo.content }}
              </blockquote>
              <p>{{ m.withdrawnAt ? "消息已撤回" : m.content }}</p>
              <template v-if="m.attachment && !m.withdrawnAt"
                ><img
                  v-if="m.attachment.type === 'image'"
                  class="message-image"
                  :src="m.attachment.url"
                  :alt="m.attachment.name"
                  loading="lazy"
                /><audio
                  v-if="m.attachment.type === 'audio'"
                  :src="m.attachment.url"
                  controls
                  preload="none"
                /><a
                  :href="m.attachment.url"
                  target="_blank"
                  rel="noopener"
                  :download="m.attachment.name"
                  >下载 {{ m.attachment.name }} ·
                  {{ Math.ceil(m.attachment.size / 1024) }}KB</a
                ></template
              >
              <div v-if="!m.withdrawnAt">
                <button
                  @click="
                    quoting = m;
                    searching = false;
                  "
                >
                  引用</button
                ><button
                  v-if="
                    (active.conversationKind === 'direct' || groupOwner) &&
                    !pinnedMessages.some((p) => p.id === m.id)
                  "
                  @click="pinMessage(m)"
                >
                  置顶消息</button
                ><template v-if="m.senderId === me"
                  ><button @click="change(m)">编辑</button
                  ><button @click="change(m, true)">撤回</button></template
                >
              </div>
            </div>
            <p v-if="!visibleMessages.length">
              {{ searching ? "没有匹配消息" : "还没有消息，打个招呼吧。" }}
            </p>
          </div>
          <p v-if="quoting">
            引用：{{ quoting.content }}
            <button @click="quoting = null">取消</button>
          </p>
          <div
            v-if="active.conversationKind !== 'channel' || groupOwner"
            class="attachment-tools"
          >
            <input
              ref="fileInput"
              type="file"
              aria-label="选择附件"
              :disabled="busy || recording"
              @change="fileChosen"
            /><button :disabled="busy" @click="record">
              {{ recording ? "停止并发送语音" : "录制语音" }}</button
            ><small>单文件5MB以内 · 语音最长60秒</small>
          </div>
          <form
            v-if="active.conversationKind !== 'channel' || groupOwner"
            class="composer"
            @submit.prevent="send"
          >
            <textarea
              v-model="content"
              aria-label="消息内容"
              maxlength="10000"
              placeholder="发送消息…"
              @input="rt.sendTyping(selected)"
            /><button :disabled="busy || !content.trim()">
              {{ busy ? "发送中…" : "发送" }}
            </button>
          </form>
        </template>
        <p v-else>选择通讯录中的用户开始私聊，或新建群聊。</p>
      </article>
    </div>
  </section>
</template>
<style scoped>
.messages {
  max-width: 1500px;
  margin: auto;
  padding: 22px 18px 110px;
  color: #dce1d4;
}
.messages h1 {
  font-size: 36px;
  color: #d7fa00;
}
.workspace {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 18px;
}
.workspace aside,
.workspace article {
  padding: 18px;
  background: #202220;
  border: 2px solid #3c4038;
  border-radius: 22px;
  min-width: 0;
}
.messages button {
  background: #22281d;
  color: #dce6cd;
  border: 1px solid #5f6c4b;
  border-radius: 18px;
  padding: 8px 12px;
  margin: 3px;
  cursor: pointer;
}
.messages button:disabled {
  opacity: 0.5;
  cursor: default;
}
.messages input,
.messages textarea,
.messages select {
  background: #10120e;
  color: #eee;
  border: 1px solid #526344;
  border-radius: 12px;
  padding: 12px;
  max-width: 100%;
  box-sizing: border-box;
}
.contact-list {
  max-height: 260px;
  overflow: auto;
}
.contact {
  border-bottom: 1px solid #3c4038;
  padding-bottom: 6px;
}
.contact > button:first-child {
  display: flex;
  width: calc(100% - 6px);
  align-items: center;
  gap: 8px;
}
.contact-list img {
  width: 28px;
  height: 28px;
  border-radius: 50%;
}
.contact-list small {
  margin-left: auto;
}
.conversation {
  display: flex;
  width: calc(100% - 6px);
  flex-direction: column;
  gap: 5px;
  align-items: flex-start;
}
.conversation span {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.conversation[aria-pressed="true"] {
  border-color: #d7fa00;
}
.timeline {
  height: 440px;
  overflow: auto;
  padding: 12px;
}
.bubble {
  margin: 12px 0;
  background: #141710;
  border-radius: 16px;
  padding: 12px;
  max-width: 85%;
  overflow-wrap: anywhere;
}
.message-image {
  display: block;
  max-width: 100%;
  max-height: 360px;
  border-radius: 12px;
}
.bubble audio {
  display: block;
  max-width: 100%;
}
.attachment-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.attachment-tools input {
  max-width: 100%;
}
.bubble.mine {
  margin-left: auto;
  border: 1px solid #758345;
}
.bubble p {
  white-space: pre-wrap;
}
.bubble small {
  font-size: 10px;
  color: #9ca58c;
}
.bubble button {
  font-size: 10px;
}
.composer,
.history-search {
  display: flex;
  gap: 8px;
}
.composer textarea,
.history-search input {
  flex: 1;
  min-width: 0;
}
.messages a {
  color: #d7fa00;
}
.messages [role="alert"] {
  color: #ffad96;
}
.messages [role="status"] {
  color: #d7fa00;
}
.messages blockquote {
  border-left: 3px solid #7d8764;
  margin: 4px;
  padding-left: 10px;
  color: #9da48e;
}
.messages details {
  padding: 12px 0;
  border-bottom: 1px solid #414938;
  overflow-wrap: anywhere;
}
.messages summary {
  cursor: pointer;
  color: #d7fa00;
}
.group-form {
  max-height: 340px;
  overflow: auto;
}
.group-form label {
  display: block;
  margin: 7px 0;
}
.group-form input[type="checkbox"] {
  margin-right: 10px;
}
.friend {
  margin: 12px 0;
  border-bottom: 1px solid #414938;
}
.history-search {
  margin: 12px 0;
  flex-wrap: wrap;
}
.group-info {
  max-height: 300px;
  overflow: auto;
}
@media (max-width: 768px) {
  .workspace {
    grid-template-columns: 1fr;
  }
  .timeline {
    height: 360px;
  }
  .contact-list {
    max-height: 180px;
  }
  .workspace aside {
    max-height: 420px;
    overflow: auto;
  }
  .messages {
    padding: 12px 8px 110px;
  }
}
</style>
