<template>
  <section v-if="invoice">
    <h1>Invoice {{ invoice.number }}</h1>
    <p>Order <RouterLink :to="`/orders/${invoice.orderId}`">#{{ invoice.orderId }}</RouterLink></p>
    <dl>
      <dt>Net</dt><dd><MoneyText :amount="invoice.net" :currency="invoice.currency" /></dd>
      <dt>Tax</dt><dd><MoneyText :amount="invoice.tax" :currency="invoice.currency" /></dd>
      <dt>Gross</dt><dd><MoneyText :amount="invoice.gross" :currency="invoice.currency" /></dd>
      <dt>Status</dt><dd><StatusBadge :status="invoice.status" /></dd>
      <dt>Issued</dt><dd>{{ formatDate(invoice.issuedAt) }}</dd>
    </dl>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import MoneyText from '../components/MoneyText.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { invoicesApi } from '../api/invoices';
import { formatDate } from '../utils/format';
import type { Invoice } from '../types';

const route = useRoute();
const invoice = ref<Invoice | null>(null);

onMounted(async () => {
  invoice.value = await invoicesApi.get(route.params.id as string);
});
</script>
