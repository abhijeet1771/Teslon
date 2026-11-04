package com.shopflow.events;

/** Kafka topics shared by the services. */
public final class Topics {

    public static final String ORDER_PLACED = "shop.orders.placed";
    public static final String ORDER_CANCELLED = "shop.orders.cancelled";
    public static final String PAYMENT_RESULT = "shop.payments.result";

    private Topics() {}
}
