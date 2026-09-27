import { db } from '../db';
import { emit } from '../bus';
import { sendEmail } from '../mail';

export interface CancelRequest { orderId: string; reason: string; }
export interface CancelResponse { cancelled: boolean; refundCents: number; }

@Post('/api/orders/:orderId/cancel')
export async function cancelOrder(req: CancelRequest): Promise<CancelResponse> {
  await db.query(`UPDATE orders SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [req.orderId]);
  await db.query(`INSERT INTO refunds (order_id, amount_cents) VALUES ($1, $2)`, [req.orderId, 0]);
  await sendEmail(req.orderId, 'order-cancelled');
  emit('order.cancelled');
  await fetch('https://payments.internal/api/refund', { method: 'POST' });
  return { cancelled: true, refundCents: 0 };
}
