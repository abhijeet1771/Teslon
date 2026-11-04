import axios from 'axios';
import { token } from '../utils/session';

export const http = axios.create({
  baseURL: '/api',
  timeout: 10000,
});

http.interceptors.request.use((config) => {
  const t = token();
  if (t) {
    config.headers.Authorization = `Bearer ${t}`;
  }
  return config;
});

http.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      window.location.href = '/login';
    }
    return Promise.reject(error);
  },
);
