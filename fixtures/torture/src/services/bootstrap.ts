import { register } from './container';
import { PriceService } from './PriceService';
register('price', new PriceService());                                            // M2 registration
