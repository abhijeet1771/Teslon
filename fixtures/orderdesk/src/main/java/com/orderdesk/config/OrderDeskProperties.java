package com.orderdesk.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "orderdesk")
public record OrderDeskProperties(int pageSize, String currency, int lowStockThreshold, String stockAlertCron) {}
