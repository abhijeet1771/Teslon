package com.shopflow.catalog.web;

import java.math.BigDecimal;

public record ProductDto(String sku, String name, String description, BigDecimal price, int stock, boolean inStock) {}
