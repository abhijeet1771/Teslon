import { ICustomer } from '../customers/customer.model';
import { IProduct } from '../products/product.model';

export type OrderStatus = 'NEW' | 'PAID' | 'SHIPPED' | 'CANCELLED';

export interface IOrderItem {
  id: number;
  product: Pick<IProduct, 'id' | 'sku' | 'name' | 'price'>;
  quantity: number;
  unitPrice: number;
}

export interface IOrder {
  id: number;
  customer: Pick<ICustomer, 'id' | 'name' | 'email' | 'tier'>;
  status: OrderStatus;
  placedAt: string;
  items: IOrderItem[];
  total: number;
  note?: string | null;
}

export interface IOrderSummary {
  id: number;
  customerName: string;
  status: OrderStatus;
  total: number;
  placedAt: string;
}

export interface ICreateOrder {
  customerId: number;
  lines: { productId: number; quantity: number }[];
  note?: string;
}
