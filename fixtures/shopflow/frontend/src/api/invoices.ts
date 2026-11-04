import { http } from './http';
import type { Invoice } from '../types';

export const invoicesApi = {
  list: () => http.get<Invoice[]>('/invoices').then((r) => r.data),
  get: (id: string | number) => http.get<Invoice>(`/invoices/${id}`).then((r) => r.data),
  byOrder: (orderId: string | number) => http.get<Invoice>(`/invoices/by-order/${orderId}`).then((r) => r.data),
};
