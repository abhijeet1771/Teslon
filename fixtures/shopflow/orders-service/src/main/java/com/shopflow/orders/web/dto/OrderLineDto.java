package com.shopflow.orders.web.dto;

import java.math.BigDecimal;

public record OrderLineDto(String sku, String productName, int quantity, BigDecimal unitPrice, BigDecimal lineTotal) {}
