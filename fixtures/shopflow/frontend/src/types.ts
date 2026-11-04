export interface OrderLine {
  sku: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface Order {
  id: number;
  customerName: string;
  customerEmail: string;
  status: 'PLACED' | 'PAID' | 'PAYMENT_FAILED' | 'CANCELLED' | 'SHIPPED';
  total: number;
  currency: string;
  placedAt: string;
  lines: OrderLine[];
  paymentFailureReason: string | null;
}

export interface CreateOrder {
  customerEmail: string;
  customerName: string;
  lines: { sku: string; quantity: number }[];
}

export interface Invoice {
  id: number;
  number: string;
  orderId: number;
  customerEmail: string;
  net: number;
  tax: number;
  gross: number;
  currency: string;
  status: 'OPEN' | 'PAID' | 'FAILED' | 'VOID';
  issuedAt: string;
}

export interface Product {
  sku: string;
  name: string;
  description: string | null;
  price: number;
  stock: number;
  inStock: boolean;
}

export interface ProductUpdate {
  name: string;
  description: string | null;
  price: number;
  stock: number;
}

export interface Notification {
  id: number;
  orderId: number;
  recipient: string;
  kind: string;
  subject: string;
  sentAt: string;
  status: string;
}
