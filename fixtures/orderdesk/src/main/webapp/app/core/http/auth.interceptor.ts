import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { SessionService } from '../auth/session.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const token = inject(SessionService).token();
  return next(token ? req.clone({ setHeaders: { Authorization: `Basic ${token}` } }) : req);
};
