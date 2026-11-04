package com.shopflow.billing.web;

import com.shopflow.billing.domain.Invoice;
import org.springframework.stereotype.Component;

@Component
public class InvoiceMapper {

    public InvoiceDto toDto(Invoice invoice) {
        return new InvoiceDto(
            invoice.getId(),
            invoice.getNumber(),
            invoice.getOrderId(),
            invoice.getCustomerEmail(),
            invoice.getNet(),
            invoice.getTax(),
            invoice.getGross(),
            invoice.getCurrency(),
            invoice.getStatus().name(),
            invoice.getIssuedAt()
        );
    }
}
