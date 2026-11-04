export function token(): string | null {
  return localStorage.getItem('shopflow.token');
}

export function isAdmin(): boolean {
  return localStorage.getItem('shopflow.role') === 'admin';
}
