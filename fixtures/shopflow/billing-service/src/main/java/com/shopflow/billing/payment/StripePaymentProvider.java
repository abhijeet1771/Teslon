package com.shopflow.billing.payment;

import com.stripe.exception.StripeException;
import com.stripe.model.PaymentIntent;
import com.stripe.param.PaymentIntentCreateParams;
import java.math.BigDecimal;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "billing.provider", havingValue = "stripe")
public class StripePaymentProvider implements PaymentProvider {

    @Override
    public PaymentOutcome charge(String customerEmail, BigDecimal amount, String currency) {
        try {
            PaymentIntent intent = PaymentIntent.create(PaymentIntentCreateParams.builder()
                .setAmount(amount.movePointRight(2).longValueExact())
                .setCurrency(currency.toLowerCase())
                .setReceiptEmail(customerEmail)
                .setConfirm(true)
                .build());
            return PaymentOutcome.ok(intent.getId());
        } catch (StripeException e) {
            return PaymentOutcome.failed(e.getUserMessage());
        }
    }
}
