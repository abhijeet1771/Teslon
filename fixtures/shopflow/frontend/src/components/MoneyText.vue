<template>
  <span class="money">{{ text }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { formatMoney } from '../utils/format';

const props = withDefaults(defineProps<{ amount: number | string; currency?: string }>(), { currency: 'EUR' });

const text = computed(() => formatMoney(props.amount, props.currency));
</script>
