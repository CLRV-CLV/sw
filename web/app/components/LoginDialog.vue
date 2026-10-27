<script setup lang="ts">
import { useMessage } from "zenless-ui";
import { resolveErrorMessage } from "~/utils/api-error";
const { visible, close } = useLoginDialog();
const auth = useAuthStore();
const { $api } = useNuxtApp();
const message = useMessage();
const scrollLock=useBodyScrollLock(),lockToken=Symbol('local-login');
watch(visible, open => { if(open)scrollLock.acquire(lockToken);else scrollLock.release(lockToken); },{immediate:true});
onBeforeUnmount(() => scrollLock.release(lockToken));
const username = ref("");
const password = ref("");
const register = ref(false);
const busy = ref(false);
const submit = async () => {
  if (busy.value) return;
  busy.value = true;
  try {
    const payload = { username: username.value.trim(), password: password.value };
    if (register.value) await $api("/v1/auth/register", { method: "POST", body: payload });
    await $api("/v1/auth/login", { method: "POST", body: payload });
    useApi().clearAllCache();
    const user = await useApi().getSelfUser();
    auth.setSession(user);
    useApi().seedSelfUser(user);
    password.value = "";
    message.success(register.value ? "注册成功，欢迎接入绳网" : "已接入绳网");
    close();
  } catch (e) {
    message.error(resolveErrorMessage(e, "无法连接账户服务"));
  } finally { busy.value = false; }
};
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="local-auth-overlay">
      <section class="local-auth" role="dialog" aria-modal="true" aria-labelledby="local-auth-title" @keydown.esc="!busy && close()">
        <header><span>INTER-KNOT // 独立账户</span><button aria-label="关闭" :disabled="busy" @click="close">×</button></header>
        <div class="local-auth-ticket" aria-hidden="true"><span>PROXY ACCESS</span><b>IK / 01</b><i /></div>
        <h2 id="local-auth-title">{{ register ? '新绳匠入网' : '欢迎接入绳网' }}</h2>
        <p>你的身份，由绳网保管。无需第三方账号。</p>
        <form @submit.prevent="submit">
          <label><span><em>01</em> 绳网用户名</span><input v-model="username" name="username" autocomplete="username" minlength="2" maxlength="40" required placeholder="2–40 字" :disabled="busy" autofocus></label>
          <label><span><em>02</em> 账户密码</span><input v-model="password" name="password" type="password" :autocomplete="register ? 'new-password' : 'current-password'" :minlength="register ? 10 : 1" maxlength="200" required placeholder="至少 10 字符" :disabled="busy"></label>
          <button class="connect" type="submit" :disabled="busy">{{ busy ? '连接中…' : register ? '创建账户并接入 →' : '接入 INTER-KNOT →' }}</button>
        </form>
        <footer class="local-auth-footer"><span>LOCAL ACCOUNT / 本地账户</span><span>● 私密连接</span></footer>
        <button class="switch" :disabled="busy" @click="register = !register">{{ register ? '已有账户？返回登录' : '还没有账户？本地注册' }}</button>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.local-auth-overlay{position:fixed;inset:0;background:#060906dc;z-index:10000;display:grid;place-items:center;padding:20px;backdrop-filter:blur(8px)}
.local-auth{position:relative;width:min(450px,100%);max-height:calc(100dvh - 40px);overflow:auto;background:#1c2118;border:3px solid #555f46;border-radius:25px 25px 0 25px;padding:26px;color:#eee;box-shadow:9px 9px 0 #030503}
header{display:flex;align-items:center;justify-content:space-between;color:#a7b395;font:10px "InterKnot Sans",monospace;letter-spacing:1px}header button{font-size:26px;background:#0a0f07;border:1px solid #59644a;border-radius:6px 6px 0 6px;color:#e3e8d9;cursor:pointer;width:32px;height:32px;line-height:26px}
.local-auth-ticket{display:flex;align-items:center;gap:14px;background:#dfe2d2;color:#161c11;padding:12px 14px;margin:23px -26px 20px;border-top:3px solid #090e05;border-bottom:3px solid #090e05;transform:rotate(-2deg);font:900 italic 25px/1 sans-serif;letter-spacing:-1px}.local-auth-ticket b{font:10px monospace;letter-spacing:0;white-space:nowrap}.local-auth-ticket i{margin-left:auto;width:44px;height:27px;background:repeating-linear-gradient(90deg,#161c11 0 2px,transparent 2px 5px,#161c11 5px 6px,transparent 6px 9px)}
h2{font-weight:900;font-style:italic;font-size:30px;margin:16px 0 10px;letter-spacing:-1px}p{color:#a3ad94;font-size:12px;line-height:1.7}label{display:grid;gap:9px;font-size:13px;font-weight:bold;margin:23px 0}label em{display:inline-block;color:#d7fa00;font:11px monospace;border-right:1px solid #667552;padding-right:9px;margin-right:5px}input{width:100%;border:2px solid #444f38;background:#0b1008;color:#e8eddd;border-radius:8px 8px 0 8px;padding:14px;font:inherit;outline:none}input:focus{border-color:#d7fa00;box-shadow:3px 3px 0 #080d05}.connect{width:100%;padding:16px;border:2px solid #e7ff4b;border-radius:8px 8px 0 8px;background:#d7fa00;color:#111;font-size:16px;font-weight:900;font-style:italic;box-shadow:3px 4px #080d05;cursor:pointer}.connect:hover{background:#e6ff4c}.switch{display:block;margin:18px auto 0;background:none;border:0;color:#d4dbc8;font-size:12px;cursor:pointer}.local-auth-footer{display:flex;justify-content:space-between;margin-top:22px;border-top:1px dashed #58634a;padding-top:12px;font:8px "InterKnot Sans",monospace;color:#8e9d7c}button:disabled{opacity:.5;cursor:wait}
@media(max-width:480px){.local-auth{padding:22px}.local-auth-ticket{margin-left:-22px;margin-right:-22px;font-size:22px}h2{font-size:26px}}
</style>
