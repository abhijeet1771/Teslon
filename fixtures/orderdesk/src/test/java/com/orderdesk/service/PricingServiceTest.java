package com.orderdesk.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.orderdesk.domain.Customer;
import com.orderdesk.domain.CustomerTier;
import com.orderdesk.domain.OrderItem;
import java.math.BigDecimal;
import java.util.List;
import org.junit.jupiter.api.Test;

class PricingServiceTest {

    @Test
    void goldCustomersGetFivePercentOff() {
        Customer gold = new Customer();
        gold.setTier(CustomerTier.GOLD);
        OrderItem item = new OrderItem();
        item.setQuantity(2);
        item.setUnitPrice(new BigDecimal("10.00"));
        assertThat(new PricingService().orderTotal(gold, List.of(item))).isEqualByComparingTo("19.00");
    }
}
