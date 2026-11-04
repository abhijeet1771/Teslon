import { Injectable, signal } from '@angular/core';

export interface ISession {
  login: string;
  roles: string[];
}

@Injectable({ providedIn: 'root' })
export class SessionService {
  readonly session = signal<ISession | null>(null);

  token(): string | null {
    return sessionStorage.getItem('orderdesk.token');
  }

  hasRole(role: string): boolean {
    return this.session()?.roles.includes(role) ?? false;
  }
}
