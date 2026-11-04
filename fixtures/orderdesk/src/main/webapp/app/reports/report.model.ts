export interface ITopProduct {
  sku: string;
  name: string;
  quantity: number;
}

export interface IDailySales {
  day: string;
  orders: number;
  revenue: number;
  top: ITopProduct[];
}
