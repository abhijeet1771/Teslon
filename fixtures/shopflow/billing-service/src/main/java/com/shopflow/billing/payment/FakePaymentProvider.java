package com.shopflow.billing.payment;

import java.math.BigDecimal;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/** For local runs and test environments: declines anything over 1000. */
@Component
@ConditionalOnProperty(name = "billing.provider", havingValue = "fake")
public class FakePaymentProvider implements PaymentProvider {

    @Override
    public PaymentOutcome charge(String customerEmail, BigDecimal amount, String currency) {
        if (amount.compareTo(new BigDecimal("1000")) > 0) {
            return PaymentOutcome.failed("Card declined");
        }
        return PaymentOutcome.ok("fake-" + UUID.randomUUID());
    }
}
