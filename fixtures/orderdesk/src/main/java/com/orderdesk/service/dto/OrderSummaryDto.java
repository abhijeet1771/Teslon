package com.orderdesk.service.dto;

import com.orderdesk.domain.OrderStatus;
import java.math.BigDecimal;
import java.time.Instant;

public record OrderSummaryDto(Long id, String customerName, OrderStatus status, BigDecimal total, Instant placedAt) {}
