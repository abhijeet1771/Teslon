const reg = new Map<string, any>();
export const register = (k: string, v: any) => reg.set(k, v);
export const resolve = (k: string) => reg.get(k);
