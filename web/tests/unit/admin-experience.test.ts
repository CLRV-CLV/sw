import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const read=(path:string)=>readFileSync(`${process.cwd()}/app/${path}`,'utf8');
it('shows the home admin entry only to administrators and uses the precious-currency wording',()=>{
 const home=read('components/HomeAccountTools.vue');expect(home).toContain('v-if="auth.user?.isAdmin"');expect(home).toContain('珍贵的货币');expect(home).not.toContain('管理员发放');
});
it('keeps the front-end navigation outside the admin workspace',()=>{
 const app=read('app.vue');expect(app).toContain('<AppHeader v-if="route.path !== \'/admin\'"');expect(app).toContain('showMobileBottomNav && route.path !== \'/admin\'');
 const admin=read('pages/admin.vue');expect(admin).toContain('站点外观 / 设置');expect(admin).toContain('用户 / 会话');expect(admin).toContain('资料 / 等级 / 货币');
});
it('does not dismiss the login form on backdrop gestures and shares the scroll lock',()=>{
 const dialog=read('components/LoginDialog.vue');expect(dialog).not.toContain('@click.self');expect(dialog).toContain('useBodyScrollLock()');expect(dialog).toContain('aria-label="关闭"');
});
it('routes resident AI through server-owned configuration, approval, and role-specific private turns',()=>{
 const admin=read('components/ResidentAIAdmin.vue'),chat=read('components/ResidentAIChat.vue');
 expect(admin).toContain('/v1/admin/ai/config');expect(admin).toContain('我已核对Wiki，审核通过');expect(admin).toContain('JSON');expect(admin).toContain('生成文章草稿');
 expect(chat).toContain('/v1/ai/chats/');expect(chat).toContain('clientId: p.id');expect(chat).not.toContain('Authorization');expect(chat).not.toContain('apiKey');expect(chat).not.toContain('rolePolicy');
 expect(read('pages/messages.vue')).toContain('驻站角色AI');
});
