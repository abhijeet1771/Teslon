package com.shopflow.orders.web.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import java.util.List;

public record CreateOrderRequest(
    @NotBlank @Email String customerEmail,
    @NotBlank String customerName,
    @NotEmpty @Valid List<Line> lines
) {
    public record Line(@NotBlank String sku, @Min(1) @Max(50) int quantity) {}
}
