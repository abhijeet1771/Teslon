package com.shopflow.orders.service;

import com.shopflow.events.PaymentResultMessage;
import com.shopflow.orders.client.CatalogClient;
import com.shopflow.orders.client.ProductView;
import com.shopflow.orders.domain.Order;
import com.shopflow.orders.domain.OrderLine;
import com.shopflow.orders.domain.OrderStatus;
import com.shopflow.orders.messaging.OrderEventsPublisher;
import com.shopflow.orders.repository.OrderRepository;
import com.shopflow.orders.web.dto.CreateOrderRequest;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional
public class OrderService {

    private final OrderRepository orderRepository;
    private final CatalogClient catalogClient;
    private final OrderEventsPublisher events;

    public OrderService(OrderRepository orderRepository, CatalogClient catalogClient, OrderEventsPublisher events) {
        this.orderRepository = orderRepository;
        this.catalogClient = catalogClient;
        this.events = events;
    }

    @Transactional(readOnly = true)
    public List<Order> list() {
        return orderRepository.findAllByOrderByCreatedAtDesc();
    }

    @Transactional(readOnly = true)
    public Order get(Long id) {
        return orderRepository.findById(id).orElseThrow(() -> new OrderNotFoundException(id));
    }

    public Order place(CreateOrderRequest request) {
        Order order = new Order();
        order.setCustomerEmail(request.customerEmail());
        order.setCustomerName(request.customerName());
        order.setStatus(OrderStatus.PLACED);
        order.setCurrency("EUR");
        order.setCreatedAt(Instant.now());
        BigDecimal total = BigDecimal.ZERO;
        for (CreateOrderRequest.Line l : request.lines()) {
            ProductView product = catalogClient.product(l.sku());
            OrderLine line = OrderLine.builder()
                .order(order)
                .sku(product.sku())
                .productName(product.name())
                .quantity(l.quantity())
                .unitPrice(product.price())
                .build();
            order.getLines().add(line);
            total = total.add(product.price().multiply(BigDecimal.valueOf(l.quantity())));
        }
        order.setTotal(total);
        Order saved = orderRepository.save(order);
        events.orderPlaced(saved);
        return saved;
    }

    public Order cancel(Long id, String reason) {
        Order order = get(id);
        if (order.getStatus() == OrderStatus.SHIPPED) {
            throw new IllegalStateException("A shipped order cannot be cancelled");
        }
        order.setStatus(OrderStatus.CANCELLED);
        events.orderCancelled(order, reason);
        return order;
    }

    public void paymentResult(PaymentResultMessage result) {
        Order order = get(result.orderId());
        if (order.getStatus() == OrderStatus.CANCELLED) {
            return;
        }
        order.setStatus(result.paid() ? OrderStatus.PAID : OrderStatus.PAYMENT_FAILED);
        order.setPaymentFailureReason(result.failureReason());
    }
}
