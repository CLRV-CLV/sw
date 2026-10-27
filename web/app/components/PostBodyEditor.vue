<script setup lang="ts">
import { formatBodyText, sanitizeBodyHtml } from '~/utils/format-body';
const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const mode = ref<'source'|'rich'|'preview'>('source');
const rich = ref<HTMLDivElement>();
const preview = computed(() => formatBodyText(props.modelValue));
const help = ref(false);
const controls = [
  ['bold','B','加粗'], ['italic','I','斜体'], ['underline','U','下划线'], ['strikeThrough','S','删除线'],
  ['insertUnorderedList','• 列表','无序列表'], ['insertOrderedList','1. 列表','有序列表'],
  ['justifyLeft','≡','左对齐'], ['justifyCenter','≡','居中'], ['undo','↶','撤销'], ['redo','↷','重做'],
];
async function selectMode(next: typeof mode.value) {
  mode.value = next;
  if (next === 'rich') { await nextTick(); if(rich.value) rich.value.innerHTML = preview.value; }
}
watch(() => props.modelValue, () => {
  if(mode.value==='rich' && rich.value && document.activeElement !== rich.value) rich.value.innerHTML = preview.value;
});
function changed() { if(rich.value) emit('update:modelValue', sanitizeBodyHtml(rich.value.innerHTML)); }
function command(name: string, value?: string) {
  rich.value?.focus();
  document.execCommand("styleWithCSS", false, "true");
  document.execCommand(name, false, value);
  changed();
}
function insert(kind: 'link'|'image'|'table'|'code') {
  if(kind==='table') return command('insertHTML','<table><thead><tr><th>标题一</th><th>标题二</th></tr></thead><tbody><tr><td>内容</td><td>内容</td></tr></tbody></table><p><br></p>');
  if(kind==='code') return command('formatBlock','pre');
  const url = window.prompt(kind==='link'?'链接地址（https://…）':'图片地址（https://… 或本站路径）');
  if(!url || !/^(https?:\/\/|\/(?!\/))/.test(url.trim())) return;
  if(kind==='link') command('createLink',url.trim());
  else { const image=document.createElement('img'); image.src=url.trim(); image.alt='帖子图片'; command('insertHTML',sanitizeBodyHtml(image.outerHTML)); }
}
function paste(event: ClipboardEvent) {
  event.preventDefault();
  const html=event.clipboardData?.getData('text/html');
  if(html) command('insertHTML',sanitizeBodyHtml(html));
  else command('insertText',event.clipboardData?.getData('text/plain')||'');
}
</script>

<template>
  <div class="post-body-editor">
    <div class="post-body-editor__tabs" role="group" aria-label="正文编辑模式">
      <button type="button" :aria-pressed="mode==='source'" @click="selectMode('source')">Markdown / HTML</button>
      <button type="button" :aria-pressed="mode==='rich'" @click="selectMode('rich')">富文本编辑</button>
      <button type="button" :aria-pressed="mode==='preview'" @click="selectMode('preview')">效果预览</button>
      <button type="button" class="help" :aria-expanded="help" @click="help=!help">语法说明</button>
    </div>
    <p v-if="help" class="post-body-editor__help">支持标题、列表、引用、表格、代码高亮、任务列表、脚注、删除线、==高亮==、H~2~O、x^2^、$公式$ 和 $$块公式$$。可混排安全 HTML。富文本编辑后以 HTML 源码保存；切换模式不会自动还原成原始 Markdown。暂不支持脚本、iframe、任意 CSS 或附件上传。</p>
    <template v-if="mode==='rich'">
      <div class="post-body-editor__tools" role="group" aria-label="富文本工具栏">
        <button v-for="[name,label,title] in controls" :key="name" type="button" :title="title" :aria-label="title" @mousedown.prevent @click="command(name!)">{{ label }}</button>
        <button type="button" @mousedown.prevent @click="command('formatBlock','h2')">标题</button>
        <button type="button" @mousedown.prevent @click="command('formatBlock','p')">正文</button>
        <button type="button" @mousedown.prevent @click="command('formatBlock','blockquote')">引用</button>
        <button type="button" @mousedown.prevent @click="insert('code')">代码</button>
        <button type="button" @mousedown.prevent @click="insert('link')">链接</button>
        <button type="button" @mousedown.prevent @click="insert('image')">图片链接</button>
        <button type="button" @mousedown.prevent @click="insert('table')">表格</button>
        <label title="文字颜色">字色<input type="color" aria-label="文字颜色" value="#d7fa00" @input="command('foreColor',($event.target as HTMLInputElement).value)"></label>
        <button type="button" @mousedown.prevent @click="command('removeFormat')">清除格式</button>
      </div>
      <div ref="rich" class="post-body-editor__rich ik-post-prose" contenteditable="true" role="textbox" aria-label="富文本正文" aria-multiline="true" @input="changed" @paste="paste" @drop.prevent />
    </template>
    <textarea v-else-if="mode==='source'" :value="modelValue" class="post-body-editor__source" aria-label="Markdown / HTML 正文" placeholder="写下你的情报… 支持 Markdown 与安全 HTML" @input="emit('update:modelValue',($event.target as HTMLTextAreaElement).value)" />
    <div v-else class="post-body-editor__preview ik-post-prose" aria-label="帖子效果预览" v-html="preview || '<p>正文预览将在这里显示。</p>'" />
    <div class="post-body-editor__status"><span>INTER-KNOT / CONTENT WORKSTATION</span><span>{{ modelValue.length }} 字符 · 安全渲染</span></div>
  </div>
</template>

<style scoped>
.post-body-editor{background:#10150e;border:1px solid #4c5740;border-radius:10px 10px 0 10px;overflow:hidden}.post-body-editor__tabs{display:flex;gap:4px;flex-wrap:wrap;padding:9px;background:#242c1e;border-bottom:1px solid #48553a}.post-body-editor button{font:700 12px "InterKnot Sans",sans-serif;color:#bfcbb1;background:#141b0f;border:1px solid #515f41;border-radius:4px 4px 0 4px;padding:7px 9px;cursor:pointer}.post-body-editor button[aria-pressed='true']{color:#10150e;background:#d7fa00;border-color:#d7fa00}.post-body-editor__tabs .help{margin-left:auto}.post-body-editor__tools{display:flex;flex-wrap:wrap;gap:5px;padding:9px;border-bottom:1px dashed #48553a}.post-body-editor__tools label{display:flex;align-items:center;gap:4px;font-size:11px;color:#bfcbb1}.post-body-editor__tools input{width:25px;height:25px;padding:0;border:0}.post-body-editor__source,.post-body-editor__rich,.post-body-editor__preview{display:block;width:100%;min-height:330px;max-height:650px;overflow:auto;padding:18px;outline:none;border:0;background:#10150e;color:#e1e7d6;font:14px/1.85 'InterKnot Sans',sans-serif;resize:vertical;overflow-wrap:anywhere}.post-body-editor__source{font-family:monospace,'InterKnot Sans';tab-size:2}.post-body-editor__rich:focus{box-shadow:inset 0 0 0 1px #d7fa00}.post-body-editor__status{display:flex;justify-content:space-between;gap:10px;padding:9px 12px;border-top:1px solid #38442d;color:#8c9b7a;font:9px 'InterKnot Sans',monospace}.post-body-editor__help{margin:0;padding:13px;background:#303b21;color:#d4dfc5;font-size:12px;line-height:1.8}@media(max-width:480px){.post-body-editor__tabs button{font-size:10px;padding:7px}.post-body-editor__source,.post-body-editor__rich,.post-body-editor__preview{padding:12px;min-height:280px}.post-body-editor__status span:first-child{display:none}}
</style>
