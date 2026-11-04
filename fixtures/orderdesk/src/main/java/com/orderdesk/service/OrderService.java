package com.orderdesk.service;

import com.orderdesk.domain.Customer;
import com.orderdesk.domain.Order;
import com.orderdesk.domain.OrderItem;
import com.orderdesk.domain.OrderStatus;
import com.orderdesk.domain.Product;
import com.orderdesk.repository.CustomerRepository;
import com.orderdesk.repository.OrderRepository;
import com.orderdesk.repository.ProductRepository;
import com.orderdesk.service.dto.CreateOrderRequest;
import com.orderdesk.service.dto.OrderLineRequest;
import com.orderdesk.service.dto.OrderSummaryDto;
import com.orderdesk.service.event.OrderPlacedEvent;
import java.time.Instant;
import java.util.List;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional
public class OrderService {

    private final OrderRepository orders;
    private final CustomerRepository customers;
    private final ProductRepository products;
    private final PricingService pricing;
    private final InventoryService inventory;
    private final ApplicationEventPublisher events;

    public OrderService(OrderRepository orders, CustomerRepository customers, ProductRepository products, PricingService pricing, InventoryService inventory, ApplicationEventPublisher events) {
        this.orders = orders;
        this.customers = customers;
        this.products = products;
        this.pricing = pricing;
        this.inventory = inventory;
        this.events = events;
    }

    public Order create(CreateOrderRequest request) {
        Customer customer = customers.findById(request.customerId()).orElseThrow();
        Order order = new Order();
        order.setCustomer(customer);
        order.setNote(request.note());
        order.setPlacedAt(Instant.now());
        for (OrderLineRequest line : request.lines()) {
            Product product = products.findById(line.productId()).orElseThrow();
            inventory.reserve(product, line.quantity());
            OrderItem item = new OrderItem();
            item.setOrder(order);
            item.setProduct(product);
            item.setQuantity(line.quantity());
            item.setUnitPrice(product.getPrice());
            order.getItems().add(item);
        }
        order.setTotal(pricing.orderTotal(customer, order.getItems()));
        Order saved = orders.save(order);
        events.publishEvent(new OrderPlacedEvent(saved.getId()));
        return saved;
    }

    public Order cancel(Long id) {
        Order order = orders.findById(id).orElseThrow();
        if (order.getStatus() == OrderStatus.SHIPPED) {
            throw new IllegalStateException("Shipped orders cannot be cancelled");
        }
        for (OrderItem item : order.getItems()) {
            inventory.release(item.getProduct(), item.getQuantity());
        }
        order.setStatus(OrderStatus.CANCELLED);
        return orders.save(order);
    }

    @Transactional(readOnly = true)
    public List<OrderSummaryDto> list() {
        return orders.findAll().stream()
            .map(o -> new OrderSummaryDto(o.getId(), o.getCustomer().getName(), o.getStatus(), o.getTotal(), o.getPlacedAt()))
            .toList();
    }

    @Transactional(readOnly = true)
    public Order find(Long id) {
        return orders.findById(id).orElseThrow();
    }
}
