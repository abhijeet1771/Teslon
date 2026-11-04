<template>
  <section>
    <h1>New order</h1>
    <div class="products">
      <div v-for="p in products" :key="p.sku" class="product">
        <span>{{ p.name }}</span>
        <MoneyText :amount="p.price" />
        <button :disabled="!p.inStock" @click="cart.add(p)">Add</button>
      </div>
    </div>
    <h2>Cart</h2>
    <ul>
      <li v-for="l in cart.lines" :key="l.sku">{{ l.quantity }} × {{ l.name }}</li>
    </ul>
    <p>Total <MoneyText :amount="cart.total" /></p>
    <form @submit.prevent="submit">
      <label>Name <input v-model="customerName" name="customerName" required /></label>
      <label>Email <input v-model="customerEmail" name="customerEmail" type="email" required /></label>
      <button type="submit" :disabled="!cart.lines.length">Place order</button>
    </form>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import MoneyText from '../components/MoneyText.vue';
import { ordersApi } from '../api/orders';
import { productsApi } from '../api/products';
import { useCartStore } from '../stores/cart';
import { useToastStore } from '../stores/toast';
import type { Product } from '../types';

const router = useRouter();
const cart = useCartStore();
const toast = useToastStore();
const products = ref<Product[]>([]);
const customerName = ref('');
const customerEmail = ref('');

onMounted(async () => {
  products.value = await productsApi.list();
});

async function submit() {
  try {
    const created = await ordersApi.create({
      customerEmail: customerEmail.value,
      customerName: customerName.value,
      lines: cart.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })),
    });
    cart.clear();
    router.push(`/orders/${created.id}`);
  } catch {
    toast.show('The order could not be placed', 'error');
  }
}
</script>
