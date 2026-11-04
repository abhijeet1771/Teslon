export type CustomerTier = 'STANDARD' | 'GOLD';

export interface ICustomer {
  id: number;
  name: string;
  email: string;
  phone?: string | null;
  tier: CustomerTier;
}

export type NewCustomer = Omit<ICustomer, 'id'>;
