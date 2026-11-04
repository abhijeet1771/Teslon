import { http } from './http';
import type { Notification } from '../types';

export async function fetchNotifications(): Promise<Notification[]> {
  const { data } = await http.get<Notification[]>('/notifications');
  return data;
}
