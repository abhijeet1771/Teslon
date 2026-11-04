package com.shopflow.billing.payment;

import java.math.BigDecimal;

public interface PaymentProvider {

    PaymentOutcome charge(String customerEmail, BigDecimal amount, String currency);
}
