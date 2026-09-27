import { renderInvoice } from './InvoiceHandler';
export const handlers: Record<string, Function> = { 'invoice.render': renderInvoice };
