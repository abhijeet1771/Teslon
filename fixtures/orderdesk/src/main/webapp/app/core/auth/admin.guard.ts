import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionService } from './session.service';

export const adminGuard: CanActivateFn = () => {
  const session = inject(SessionService);
  return session.hasRole('MANAGER') || session.hasRole('ADMIN') ? true : inject(Router).parseUrl('/');
};
