package com.shopflow.orders.client;

import java.math.BigDecimal;

/** What orders-service reads from catalog-service's product JSON. */
public record ProductView(String sku, String name, BigDecimal price, int stock) {}
