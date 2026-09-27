export async function loadPage(name: string) { return import(`./${name}Page`); }   // M1
