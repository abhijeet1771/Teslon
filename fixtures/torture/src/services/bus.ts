const subs: Record<string, Function[]> = {};
export const on = (t: string, f: Function) => (subs[t] ||= []).push(f);
export const emit = (t: string) => (subs[t] || []).forEach(f => f());
