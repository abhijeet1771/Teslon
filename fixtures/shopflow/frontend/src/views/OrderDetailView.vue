<template>
  <section v-if="order">
    <h1>Order #{{ order.id }}</h1>
    <p>{{ order.customerName }} &lt;{{ order.customerEmail }}&gt;</p>
    <StatusBadge :status="order.status" />
    <p v-if="order.status === 'PAYMENT_FAILED'" class="error">Payment failed: {{ order.paymentFailureReason }}</p>
    <OrderLinesTable :lines="order.lines" />
    <p class="total">Total <MoneyText :amount="order.total" :currency="order.currency" /></p>

    <div v-if="invoice" class="invoice">
      <h2>Invoice</h2>
      <RouterLink :to="`/invoices/${invoice.id}`">{{ invoice.number }}</RouterLink>
      <MoneyText :amount="invoice.gross" :currency="invoice.currency" />
      <StatusBadge :status="invoice.status" />
    </div>
    <p v-else class="muted">No invoice yet.</p>

    <form v-if="order.status !== 'SHIPPED' && order.status !== 'CANCELLED'" @submit.prevent="cancel">
      <label>Reason <input v-model="reason" name="reason" /></label>
      <button type="submit">Cancel order</button>
    </form>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref, toRef } from 'vue';
import MoneyText from '../components/MoneyText.vue';
import OrderLinesTable from '../components/OrderLinesTable.vue';
import StatusBadge from '../components/StatusBadge.vue';
import { ordersApi } from '../api/orders';
import { useOrderInvoice } from '../composables/useOrderInvoice';
import { useToastStore } from '../stores/toast';
import type { Order } from '../types';

const props = defineProps<{ id: string }>();
const order = ref<Order | null>(null);
const reason = ref('');
const toast = useToastStore();
const { invoice } = useOrderInvoice(toRef(props, 'id'));

onMounted(async () => {
  order.value = await ordersApi.get(props.id);
});

async function cancel() {
  if (!order.value) return;
  try {
    order.value = await ordersApi.cancel(order.value.id, reason.value || undefined);
    toast.show('Order cancelled');
  } catch {
    toast.show('This order can no longer be cancelled', 'error');
  }
}
</script>
