package com.orderdesk.service;

import com.orderdesk.domain.Order;
import com.orderdesk.domain.OrderItem;
import com.orderdesk.domain.OrderStatus;
import com.orderdesk.repository.OrderRepository;
import com.orderdesk.service.dto.DailySalesDto;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class ReportService {

    private final OrderRepository orders;
    private final PricingService pricing;

    public ReportService(OrderRepository orders, PricingService pricing) {
        this.orders = orders;
        this.pricing = pricing;
    }

    public DailySalesDto dailySales(LocalDate day) {
        List<Order> placed = orders.findAll().stream()
            .filter(o -> o.getStatus() != OrderStatus.CANCELLED)
            .filter(o -> o.getPlacedAt() != null && o.getPlacedAt().atZone(ZoneOffset.UTC).toLocalDate().equals(day))
            .toList();
        BigDecimal revenue = BigDecimal.ZERO;
        Map<String, DailySalesDto.TopProduct> top = new HashMap<>();
        for (Order order : placed) {
            for (OrderItem item : order.getItems()) {
                revenue = revenue.add(pricing.lineTotal(item.getProduct(), item.getQuantity()));
                top.merge(item.getProduct().getSku(), new DailySalesDto.TopProduct(item.getProduct().getSku(), item.getProduct().getName(), item.getQuantity()),
                    (a, b) -> new DailySalesDto.TopProduct(a.sku(), a.name(), a.quantity() + b.quantity()));
            }
        }
        List<DailySalesDto.TopProduct> best = top.values().stream().sorted(Comparator.comparingInt(DailySalesDto.TopProduct::quantity).reversed()).limit(5).toList();
        return new DailySalesDto(day, placed.size(), revenue, best);
    }
}
