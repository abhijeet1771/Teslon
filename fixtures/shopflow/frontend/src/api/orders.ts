import { http } from './http';
import type { CreateOrder, Order } from '../types';

export const ordersApi = {
  list: () => http.get<Order[]>('/orders').then((r) => r.data),
  get: (id: string | number) => http.get<Order>(`/orders/${id}`).then((r) => r.data),
  create: (body: CreateOrder) => http.post<Order>('/orders', body).then((r) => r.data),
  cancel: (id: number, reason?: string) => http.post<Order>(`/orders/${id}/cancel`, { reason }).then((r) => r.data),
};
