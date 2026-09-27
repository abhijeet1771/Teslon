export class PriceService { format(c: number) { return `$${(c/100).toFixed(2)}`; } }
