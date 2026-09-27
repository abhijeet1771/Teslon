export const isOn = (f: string) => globalThis.__flags?.[f] ?? false;
