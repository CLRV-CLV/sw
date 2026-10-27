<script setup lang="ts">
import { resolveErrorMessage } from "~/utils/api-error";
const props = withDefaults(
  defineProps<{
    modelValue?: string;
    label?: string;
    compact?: boolean;
    disabled?: boolean;
  }>(),
  { modelValue: "", label: "图片", compact: false, disabled: false },
);
const emit = defineEmits<{
  "update:modelValue": [value: string];
  uploaded: [value: string];
}>();
const busy = ref(false),
  error = ref(""),
  progress = ref(0),
  input = ref<HTMLInputElement>();
let alive = true;
onBeforeUnmount(() => {
  alive = false;
});
async function upload(event: Event) {
  const el = event.target as HTMLInputElement,
    file = el.files?.[0];
  el.value = "";
  if (!file) return;
  error.value = "";
  if (
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
      file.type,
    ) ||
    file.size > 30 * 1024 * 1024
  ) {
    error.value = "请选择30MB以内的PNG/JPEG/WebP/GIF图片";
    return;
  }
  busy.value = true;
  try {
    const result = await useApi().uploadImage(file, (p) => {
      progress.value = Math.round(p);
    });
    if (alive) {
      emit("update:modelValue", result.url);
      emit("uploaded", result.url);
    }
  } catch (e) {
    if (alive) error.value = resolveErrorMessage(e, "图片上传失败");
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="image-upload-input">
    <label v-if="!compact"
      >{{ label }}地址<input
        :value="modelValue"
        maxlength="2000"
        :disabled="disabled || busy"
        @input="
          emit('update:modelValue', ($event.target as HTMLInputElement).value)
        " /></label
    ><input
      ref="input"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      hidden
      :aria-label="`上传${label}`"
      @change="upload"
    /><button
      type="button"
      :disabled="busy || disabled"
      @click="input?.click()"
    >
      {{ busy ? `上传中 ${progress}%` : `上传${label}` }}</button
    ><small v-if="!compact"
      >支持 PNG / JPEG / WebP / GIF ·
      最大30MB；上传后保存设置生效。图片公开可见，请勿上传私密内容。</small
    ><img
      v-if="!compact && modelValue"
      :src="modelValue"
      :alt="`${label}预览`"
      class="image-upload-preview"
    />
    <p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>
<style scoped>
.image-upload-input {
  min-width: 0;
}
.image-upload-input input[hidden] {
  display: none !important;
}
.image-upload-input small {
  display: block;
  color: #9da88e;
  line-height: 1.6;
  font-size: 11px;
}
.image-upload-preview {
  display: block;
  max-width: 220px;
  max-height: 130px;
  object-fit: contain;
  margin: 10px 0;
  border: 1px solid #52603f;
  border-radius: 10px;
}
.image-upload-input button {
  background: #d7fa00;
  color: #152000;
  border: 1px solid #6b8041;
  border-radius: 12px;
  padding: 8px 12px;
  cursor: pointer;
}
.image-upload-input button:disabled {
  opacity: 0.5;
}
.image-upload-input [role="alert"] {
  color: #ffb7a0;
  font-size: 12px;
}
</style>
