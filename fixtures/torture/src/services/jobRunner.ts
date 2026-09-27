import { handlers } from '../handlers/registry';
export const runJob = (name: string) => handlers[name]();                         // M3 dynamic property access
