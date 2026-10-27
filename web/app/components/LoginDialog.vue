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
const mode = ref<'local'|'email'|'reset'>('local');
const email = ref('');
const code = ref('');
const mailAvailable = ref(false);
const sending = ref(false);
const cooldown = ref(0);
let codeTimer: ReturnType<typeof setInterval> | undefined;
onBeforeUnmount(() => { if(codeTimer)clearInterval(codeTimer); });
watch(visible, async open => {
  if(!open){ password.value=''; code.value=''; return; }
  try{const caps=await $api<{emailVerification:boolean}>('/v1/capabilities');mailAvailable.value=caps.emailVerification===true;}catch{mailAvailable.value=false;}
});
const sendCode = async () => {
 if(sending.value||cooldown.value||!mailAvailable.value)return;
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())){message.warning('请填写有效邮箱');return;}
 sending.value=true;
 try{
  const api=useApi();
  const result=await (mode.value==='reset'?api.sendResetCode(email.value.trim()):register.value?api.sendRegisterCode(email.value.trim()):api.sendLoginCode(email.value.trim()));
  cooldown.value=result.cooldown||60;
  if(codeTimer)clearInterval(codeTimer);
  codeTimer=setInterval(()=>{cooldown.value=Math.max(0,cooldown.value-1);if(!cooldown.value&&codeTimer)clearInterval(codeTimer);},1000);
  message.success(mode.value==='reset'||!register.value?'若邮箱已绑定账号，验证码将发送至邮箱':'验证码已发送，请检查收件箱及垃圾邮件');
 }catch(e){message.error(resolveErrorMessage(e,'验证码发送失败'));}finally{sending.value=false;}
};
const busy = ref(false);
const submit = async () => {
  if (busy.value) return;
  busy.value = true;
  try {
    if(mode.value==='reset'){
      await useApi().resetPassword(email.value.trim(),code.value,password.value);
      auth.clearSession();
      username.value=email.value.trim(); password.value=''; code.value=''; mode.value='local'; register.value=false;
      message.success('密码已重置，所有设备已退出，请重新登录');
      return;
    }
    if(mode.value==='email'){
      if(register.value)await useApi().registerWithCode(email.value.trim(),code.value,password.value);
      else await useApi().loginWithCode(email.value.trim(),code.value);
    }else{
      const payload = { username: username.value.trim(), password: password.value };
      if (register.value) await $api('/v1/auth/register', { method: 'POST', body: payload });
      await $api('/v1/auth/login', { method: 'POST', body: payload });
    }
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
        <h2 id="local-auth-title">{{ mode === 'reset' ? '找回账户密码' : register ? '新绳匠入网' : '欢迎接入绳网' }}</h2>
        <p>你的身份，由绳网保管。无需第三方账号。</p>
        <nav class="auth-methods" aria-label="登录方式">
          <button type="button" :disabled="busy" :class="{ selected: mode === 'local' }" @click="mode = 'local'; code = ''">用户名 / 密码</button>
          <button type="button" :disabled="busy" :class="{ selected: mode !== 'local' }" @click="mode = 'email'; code = ''">邮箱验证码</button>
        </nav>
        <p v-if="mode !== 'local' && !mailAvailable" role="status">管理员尚未配置邮件服务，请先使用本地账户。已有账户可在账户安全页绑定邮箱。</p>
        <form @submit.prevent="submit">
          <label v-if="mode === 'local'"><span><em>01</em> 用户名 / 已绑定邮箱</span><input v-model="username" name="username" autocomplete="username" minlength="2" :maxlength="register ? 40 : 254" required :placeholder="register ? '用户名 2–40 字' : '用户名或已绑定邮箱'" :disabled="busy" autofocus></label>
          <template v-if="mode !== 'local'">
            <label><span><em>01</em> 邮箱</span><input v-model="email" name="email" type="email" autocomplete="email" maxlength="254" required :disabled="busy || sending" placeholder="你的邮箱"></label>
            <label><span><em>02</em> 邮箱验证码</span><div class="code-row"><input v-model="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required :disabled="busy" placeholder="6位验证码"><button type="button" :disabled="busy || sending || cooldown > 0 || !mailAvailable" @click="sendCode">{{ sending ? '发送中…' : cooldown ? `${cooldown}秒` : '发送验证码' }}</button></div></label>
          </template>
          <label v-if="mode === 'local' || register || mode === 'reset'"><span><em>03</em> {{ mode === 'reset' ? '新密码' : '账户密码' }}</span><input v-model="password" name="password" type="password" :autocomplete="register || mode === 'reset' ? 'new-password' : 'current-password'" :minlength="register || mode === 'reset' ? 10 : 1" maxlength="200" required placeholder="至少 10 字符" :disabled="busy"></label>
          <button class="connect" type="submit" :disabled="busy || (mode !== 'local' && !mailAvailable)">{{ busy ? '连接中…' : mode === 'reset' ? '重置密码 →' : register ? '创建账户并接入 →' : '接入 INTER-KNOT →' }}</button>
        </form>
        <footer class="local-auth-footer"><span>LOCAL ACCOUNT / 本地账户</span><span>● 私密连接</span></footer>
        <button v-if="mode === 'local' && !register" class="switch" :disabled="busy" @click="mode = 'reset'; code = ''">忘记密码？通过已绑定邮箱找回</button>
        <button v-if="mode === 'reset'" class="switch" :disabled="busy" @click="mode = 'local'; register = false">返回密码登录</button>
        <button v-else class="switch" :disabled="busy" @click="register = !register; code = ''">{{ register ? '已有账户？返回登录' : mode === 'email' ? '还没有账户？邮箱注册' : '还没有账户？本地注册' }}</button>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.auth-methods{display:flex;gap:8px;margin-top:18px}.auth-methods button,.code-row button{border:1px solid #59644a;background:#10160b;color:#d4dbc8;padding:10px;border-radius:8px;font-weight:700;cursor:pointer}.auth-methods button.selected{border-color:#d7fa00;color:#d7fa00}.code-row{display:flex;gap:8px;min-width:0}.code-row input{min-width:0;flex:1}.code-row button{flex-shrink:0;font-size:12px}

.local-auth-overlay{position:fixed;inset:0;background:#060906dc;z-index:10000;display:grid;place-items:center;padding:20px;backdrop-filter:blur(8px)}
.local-auth{position:relative;width:min(450px,100%);max-height:calc(100dvh - 40px);overflow:auto;background:#1c2118;border:3px solid #555f46;border-radius:25px 25px 0 25px;padding:26px;color:#eee;box-shadow:9px 9px 0 #030503}
header{display:flex;align-items:center;justify-content:space-between;color:#a7b395;font:10px "InterKnot Sans",monospace;letter-spacing:1px}header button{font-size:26px;background:#0a0f07;border:1px solid #59644a;border-radius:6px 6px 0 6px;color:#e3e8d9;cursor:pointer;width:32px;height:32px;line-height:26px}
.local-auth-ticket{display:flex;align-items:center;gap:14px;background:#dfe2d2;color:#161c11;padding:12px 14px;margin:23px -26px 20px;border-top:3px solid #090e05;border-bottom:3px solid #090e05;transform:rotate(-2deg);font:900 italic 25px/1 sans-serif;letter-spacing:-1px}.local-auth-ticket b{font:10px monospace;letter-spacing:0;white-space:nowrap}.local-auth-ticket i{margin-left:auto;width:44px;height:27px;background:repeating-linear-gradient(90deg,#161c11 0 2px,transparent 2px 5px,#161c11 5px 6px,transparent 6px 9px)}
h2{font-weight:900;font-style:italic;font-size:30px;margin:16px 0 10px;letter-spacing:-1px}p{color:#a3ad94;font-size:12px;line-height:1.7}label{display:grid;gap:9px;font-size:13px;font-weight:bold;margin:23px 0}label em{display:inline-block;color:#d7fa00;font:11px monospace;border-right:1px solid #667552;padding-right:9px;margin-right:5px}input{width:100%;border:2px solid #444f38;background:#0b1008;color:#e8eddd;border-radius:8px 8px 0 8px;padding:14px;font:inherit;outline:none}input:focus{border-color:#d7fa00;box-shadow:3px 3px 0 #080d05}.connect{width:100%;padding:16px;border:2px solid #e7ff4b;border-radius:8px 8px 0 8px;background:#d7fa00;color:#111;font-size:16px;font-weight:900;font-style:italic;box-shadow:3px 4px #080d05;cursor:pointer}.connect:hover{background:#e6ff4c}.switch{display:block;margin:18px auto 0;background:none;border:0;color:#d4dbc8;font-size:12px;cursor:pointer}.local-auth-footer{display:flex;justify-content:space-between;margin-top:22px;border-top:1px dashed #58634a;padding-top:12px;font:8px "InterKnot Sans",monospace;color:#8e9d7c}button:disabled{opacity:.5;cursor:wait}
@media(max-width:480px){.local-auth{padding:22px}.local-auth-ticket{margin-left:-22px;margin-right:-22px;font-size:22px}h2{font-size:26px}}
</style>
