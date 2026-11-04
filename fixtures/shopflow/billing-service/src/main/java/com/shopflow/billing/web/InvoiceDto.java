package com.shopflow.billing.web;

import java.math.BigDecimal;
import java.time.Instant;

public record InvoiceDto(
    Long id,
    String number,
    Long orderId,
    String customerEmail,
    BigDecimal net,
    BigDecimal tax,
    BigDecimal gross,
    String currency,
    String status,
    Instant issuedAt
) {}
