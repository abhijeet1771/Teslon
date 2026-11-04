package com.orderdesk.jobs;

import com.orderdesk.config.OrderDeskProperties;
import com.orderdesk.domain.Product;
import com.orderdesk.repository.ProductRepository;
import com.orderdesk.service.NotificationService;
import java.util.List;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class StockAlertJob {

    private final ProductRepository products;
    private final NotificationService notifications;
    private final OrderDeskProperties properties;

    public StockAlertJob(ProductRepository products, NotificationService notifications, OrderDeskProperties properties) {
        this.products = products;
        this.notifications = notifications;
        this.properties = properties;
    }

    @Scheduled(cron = "${orderdesk.stock-alert-cron}")
    public void alert() {
        List<Product> low = products.findByStockLessThan(properties.lowStockThreshold());
        if (!low.isEmpty()) {
            notifications.lowStock(low);
        }
    }
}
