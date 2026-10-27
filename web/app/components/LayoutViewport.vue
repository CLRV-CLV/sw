<script setup lang="ts">
/** A real layout viewport keeps CSS media queries, masonry and dialogs in sync.
 * Same-origin content shares accounts and storage; never wraps the native client.
 * No recursive frame: the inner application always opens the ordinary root route.
 */
const props = withDefaults(defineProps<{ mode: 'web' | 'h5'; src?: string }>(), { src: '/' });
const width = ref(1440);
const height = ref(900);
const update = () => { width.value = window.innerWidth; height.value = window.innerHeight; };
onMounted(() => { update(); window.addEventListener('resize', update); });
onBeforeUnmount(() => window.removeEventListener('resize', update));
const layoutWidth = computed(() => props.mode === 'web' ? Math.max(1280, width.value) : Math.min(430, width.value));
const scale = computed(() => Math.min(1, width.value / layoutWidth.value));
const frameStyle = computed(() => ({
  width: `${layoutWidth.value}px`, height: `${height.value / scale.value}px`,
  transform: `scale(${scale.value})`,
  left: `${Math.max(0, (width.value - layoutWidth.value * scale.value) / 2)}px`,
}));
</script>

<template>
  <section class="layout-viewport" :aria-label="mode === 'web' ? '桌面 Web 模式' : '移动 H5 模式'">
    <iframe :src="props.src" :title="mode === 'web' ? '绳网 · Web' : '绳网 · H5'" :style="frameStyle" allow="microphone; camera; fullscreen; clipboard-write" />
  </section>
</template>

<style scoped>
.layout-viewport { position:fixed; inset:0; overflow:hidden; background:#080808; }
iframe { position:absolute; top:0; border:0; transform-origin:top left; background:#121212; }
</style>
