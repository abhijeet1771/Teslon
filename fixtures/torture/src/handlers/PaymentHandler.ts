import { emit } from '../services/bus';
export const pay = () => emit('order.paid');                                      // M4 publisher
