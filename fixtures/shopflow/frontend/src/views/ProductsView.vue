<template>
  <section>
    <h1>Products</h1>
    <table>
      <thead>
        <tr><th>Name</th><th>SKU</th><th>Price</th><th>Stock</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="p in products" :key="p.sku">
          <td>{{ p.name }}</td>
          <td>{{ p.sku }}</td>
          <td><MoneyText :amount="p.price" /></td>
          <td>
            <span v-if="p.inStock">{{ p.stock }}</span>
            <span v-else class="badge muted">Sold out</span>
          </td>
          <td>
            <button :disabled="!p.inStock" @click="cart.add(p)">Add to cart</button>
            <RouterLink v-if="admin" :to="`/products/${p.sku}/edit`">Edit</RouterLink>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import MoneyText from '../components/MoneyText.vue';
import { productsApi } from '../api/products';
import { useCartStore } from '../stores/cart';
import { isAdmin } from '../utils/session';
import type { Product } from '../types';

const products = ref<Product[]>([]);
const cart = useCartStore();
const admin = isAdmin();

onMounted(async () => {
  products.value = await productsApi.list();
});
</script>
