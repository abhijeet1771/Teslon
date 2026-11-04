package com.shopflow.orders.web;

import com.shopflow.orders.mapper.OrderMapper;
import com.shopflow.orders.service.OrderService;
import com.shopflow.orders.web.dto.CancelRequest;
import com.shopflow.orders.web.dto.CreateOrderRequest;
import com.shopflow.orders.web.dto.OrderDto;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/orders")
public class OrderController {

    private final OrderService orderService;
    private final OrderMapper orderMapper;

    public OrderController(OrderService orderService, OrderMapper orderMapper) {
        this.orderService = orderService;
        this.orderMapper = orderMapper;
    }

    @GetMapping
    public List<OrderDto> list() {
        return orderService.list().stream().map(orderMapper::toDto).toList();
    }

    @GetMapping("/{id}")
    public OrderDto get(@PathVariable Long id) {
        return orderMapper.toDto(orderService.get(id));
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public OrderDto create(@Valid @RequestBody CreateOrderRequest request) {
        return orderMapper.toDto(orderService.place(request));
    }

    @PostMapping("/{id}/cancel")
    public OrderDto cancel(@PathVariable Long id, @RequestBody(required = false) CancelRequest request) {
        return orderMapper.toDto(orderService.cancel(id, request == null ? null : request.reason()));
    }
}
