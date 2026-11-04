package com.shopflow.orders.web.dto;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;

public record OrderDto(
    Long id,
    String customerName,
    String customerEmail,
    String status,
    BigDecimal total,
    String currency,
    Instant placedAt,
    List<OrderLineDto> lines,
    String paymentFailureReason
) {}
