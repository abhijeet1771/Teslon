package com.shopflow.billing.domain;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;

@Entity
@Table(name = "invoices")
public class Invoice {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "order_id", nullable = false, unique = true)
    private Long orderId;

    @Column(nullable = false)
    private String number;

    @Column(name = "customer_email", nullable = false)
    private String customerEmail;

    private BigDecimal net;
    private BigDecimal tax;
    private BigDecimal gross;
    private String currency;

    @Enumerated(EnumType.STRING)
    private InvoiceStatus status;

    @Column(name = "issued_at")
    private Instant issuedAt;

    @Column(name = "payment_reference")
    private String paymentReference;

    protected Invoice() {}

    public static Builder builder() {
        return new Builder();
    }

    public Long getId() { return id; }
    public Long getOrderId() { return orderId; }
    public String getNumber() { return number; }
    public String getCustomerEmail() { return customerEmail; }
    public BigDecimal getNet() { return net; }
    public BigDecimal getTax() { return tax; }
    public BigDecimal getGross() { return gross; }
    public String getCurrency() { return currency; }
    public InvoiceStatus getStatus() { return status; }
    public void setStatus(InvoiceStatus status) { this.status = status; }
    public Instant getIssuedAt() { return issuedAt; }
    public String getPaymentReference() { return paymentReference; }
    public void setPaymentReference(String paymentReference) { this.paymentReference = paymentReference; }

    public static final class Builder {
        private final Invoice invoice = new Invoice();

        public Builder orderId(Long orderId) { invoice.orderId = orderId; return this; }
        public Builder number(String number) { invoice.number = number; return this; }
        public Builder customerEmail(String customerEmail) { invoice.customerEmail = customerEmail; return this; }
        public Builder net(BigDecimal net) { invoice.net = net; return this; }
        public Builder tax(BigDecimal tax) { invoice.tax = tax; return this; }
        public Builder gross(BigDecimal gross) { invoice.gross = gross; return this; }
        public Builder currency(String currency) { invoice.currency = currency; return this; }
        public Builder issuedAt(Instant issuedAt) { invoice.issuedAt = issuedAt; return this; }

        public Invoice build() {
            invoice.status = InvoiceStatus.OPEN;
            return invoice;
        }
    }
}
