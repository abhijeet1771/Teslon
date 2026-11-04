package com.shopflow.billing.payment;

public record PaymentOutcome(boolean success, String reference, String failureReason) {

    public static PaymentOutcome ok(String reference) {
        return new PaymentOutcome(true, reference, null);
    }

    public static PaymentOutcome failed(String reason) {
        return new PaymentOutcome(false, null, reason);
    }
}
