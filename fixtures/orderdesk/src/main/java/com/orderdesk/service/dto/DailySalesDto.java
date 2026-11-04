package com.orderdesk.service.dto;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;

public record DailySalesDto(LocalDate day, int orders, BigDecimal revenue, List<TopProduct> top) {

    public record TopProduct(String sku, String name, int quantity) {}
}
