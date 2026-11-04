<template>
  <section>
    <h1>Edit {{ form.name }}</h1>
    <form @submit.prevent="save">
      <label>Name <input v-model="form.name" name="name" required /></label>
      <label>Description <textarea v-model="form.description" name="description" /></label>
      <label>Price <input v-model.number="form.price" name="price" type="number" step="0.01" min="0.01" /></label>
      <label>Stock <input v-model.number="form.stock" name="stock" type="number" min="0" /></label>
      <button type="submit">Save</button>
    </form>
  </section>
</template>

<script setup lang="ts">
import { onMounted, reactive } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { productsApi } from '../api/products';
import { useToastStore } from '../stores/toast';
import type { ProductUpdate } from '../types';

const route = useRoute();
const router = useRouter();
const toast = useToastStore();
const sku = route.params.sku as string;
const form = reactive<ProductUpdate>({ name: '', description: null, price: 0, stock: 0 });

onMounted(async () => {
  const p = await productsApi.get(sku);
  form.name = p.name;
  form.description = p.description;
  form.price = p.price;
  form.stock = p.stock;
});

async function save() {
  try {
    await productsApi.update(sku, { ...form });
    router.push('/products');
  } catch {
    toast.show('The product could not be saved', 'error');
  }
}
</script>
