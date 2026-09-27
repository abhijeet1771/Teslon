export function formatMoney(cents: number) { return `$${(cents / 100).toFixed(2)}`; }
export function applyDiscount(cents: number, pct: number) { return Math.round(cents * (1 - pct / 100)); }
