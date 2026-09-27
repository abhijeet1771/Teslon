import { isOn } from './flags';
export const check = (area: string) => isOn(`${area}-pricing`);                   // M16 runtime-built flag name
