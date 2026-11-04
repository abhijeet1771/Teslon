package com.shopflow.events;

/** Published by billing-service on shop.payments.result after it charges an order. */
public record PaymentResultMessage(Long orderId, Long invoiceId, boolean paid, String failureReason) {}
