import * as all from './PriceService';
export const names = Object.keys(all).map(k => (all as any)[k]);                  // M13 reflection over a namespace
