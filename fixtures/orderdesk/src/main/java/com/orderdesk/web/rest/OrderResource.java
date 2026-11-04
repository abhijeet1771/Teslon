package com.orderdesk.web.rest;

import com.orderdesk.domain.Order;
import com.orderdesk.service.OrderService;
import com.orderdesk.service.dto.CreateOrderRequest;
import com.orderdesk.service.dto.OrderSummaryDto;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderResource {

    private final OrderService orders;

    public OrderResource(OrderService orders) {
        this.orders = orders;
    }

    @GetMapping
    public List<OrderSummaryDto> list() {
        return orders.list();
    }

    @GetMapping("/{id}")
    public Order get(@PathVariable Long id) {
        return orders.find(id);
    }

    @PostMapping
    public Order create(@Valid @RequestBody CreateOrderRequest request) {
        return orders.create(request);
    }

    @PostMapping("/{id}/cancel")
    public Order cancel(@PathVariable Long id) {
        return orders.cancel(id);
    }
}
