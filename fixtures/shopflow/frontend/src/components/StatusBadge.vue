<template>
  <span :class="['badge', tone]">{{ label }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ status: string }>();

const TONES: Record<string, string> = {
  PLACED: 'info',
  PAID: 'success',
  PAYMENT_FAILED: 'danger',
  CANCELLED: 'muted',
  SHIPPED: 'primary',
  OPEN: 'info',
  FAILED: 'danger',
  VOID: 'muted',
};

const tone = computed(() => TONES[props.status] ?? 'muted');
const label = computed(() => props.status.replace('_', ' ').toLowerCase());
</script>
