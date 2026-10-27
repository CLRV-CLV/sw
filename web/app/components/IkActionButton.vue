<script setup lang="ts">
withDefaults(
  defineProps<{ type?: "button" | "submit" | "reset"; primary?: boolean }>(),
  { type: "submit", primary: false },
);
</script>
<template>
  <z-button :native-type="type" :highlight="primary" class="ik-action-button"
    ><slot
  /></z-button>
</template>
<style scoped>
.ik-action-button {
  white-space: normal;
  line-height: 1.25;
  box-sizing: border-box;
  max-width: 100%;
}
</style>
