<template>
  <div class="toasts">
    <div v-for="m in toast.messages" :key="m.id" :class="['toast', m.kind]" @click="toast.dismiss(m.id)">{{ m.text }}</div>
  </div>
</template>

<script setup lang="ts">
import { useToastStore } from '../stores/toast';

const toast = useToastStore();
</script>
