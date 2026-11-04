package com.orderdesk.service.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;

public record CreateOrderRequest(
    @NotNull Long customerId,
    @NotEmpty List<@Valid OrderLineRequest> lines,
    @Size(max = 500) String note
) {}
