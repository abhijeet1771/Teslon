export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatMoney(amount: number | string, currency = 'EUR'): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(Number(amount));
}
