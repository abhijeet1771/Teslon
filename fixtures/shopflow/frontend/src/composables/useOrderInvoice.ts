import { ref, watchEffect, type Ref } from 'vue';
import { invoicesApi } from '../api/invoices';
import type { Invoice } from '../types';

/** The invoice billing made for an order, once it exists. */
export function useOrderInvoice(orderId: Ref<string>) {
  const invoice = ref<Invoice | null>(null);
  watchEffect(async () => {
    invoice.value = await invoicesApi.byOrder(orderId.value).catch(() => null);
  });
  return { invoice };
}
