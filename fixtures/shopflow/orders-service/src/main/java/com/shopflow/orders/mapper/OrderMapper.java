package com.shopflow.orders.mapper;

import com.shopflow.orders.domain.Order;
import com.shopflow.orders.domain.OrderLine;
import com.shopflow.orders.web.dto.OrderDto;
import com.shopflow.orders.web.dto.OrderLineDto;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;

@Mapper(componentModel = "spring")
public interface OrderMapper {

    @Mapping(target = "placedAt", source = "createdAt")
    @Mapping(target = "status", expression = "java(order.getStatus().name())")
    OrderDto toDto(Order order);

    @Mapping(target = "lineTotal", expression = "java(line.getUnitPrice().multiply(java.math.BigDecimal.valueOf(line.getQuantity())))")
    OrderLineDto toLineDto(OrderLine line);
}
