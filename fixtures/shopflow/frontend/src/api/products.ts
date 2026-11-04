import { http } from './http';
import type { Product, ProductUpdate } from '../types';

export const productsApi = {
  list: () => http.get<Product[]>('/products').then((r) => r.data),
  get: (sku: string) => http.get<Product>(`/products/${sku}`).then((r) => r.data),
  update: (sku: string, body: ProductUpdate) => http.put<Product>(`/products/${sku}`, body).then((r) => r.data),
};
