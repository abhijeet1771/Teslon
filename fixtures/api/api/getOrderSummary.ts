import { requireAuth } from '../mw/auth';
import { db } from '../db';
import { isOn } from '../flags';

export interface OrderSummaryRequest { orderId: string; includeTax?: boolean; }
export interface OrderSummaryResponse { id: string; totalCents: number; currency: string; lines: number; }

@Get('/api/orders/:orderId/summary')
@UseGuards(requireAuth)
export async function getOrderSummary(req: OrderSummaryRequest): Promise<OrderSummaryResponse> {
  if (!req.orderId) throw new BadRequestError('orderId required');
  const order = await db.query(`SELECT id, total_cents, currency FROM orders WHERE id = $1`, [req.orderId]);
  if (!order) throw new NotFoundError('order not found');
  const lines = await db.query(`SELECT count(*) FROM order_lines WHERE order_id = $1`, [req.orderId]);
  if (isOn('tax-v2') && req.includeTax) {
    await fetch('https://tax.internal/api/calculate', { method: 'POST' });
  }
  return { id: order.id, totalCents: order.total_cents, currency: order.currency, lines: lines.count };
}
