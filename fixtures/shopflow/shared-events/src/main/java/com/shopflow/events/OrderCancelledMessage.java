package com.shopflow.events;

/** Published by orders-service on shop.orders.cancelled. */
public record OrderCancelledMessage(Long orderId, String customerEmail, String reason) {}
