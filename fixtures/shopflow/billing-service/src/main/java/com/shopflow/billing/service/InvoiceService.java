package com.shopflow.billing.service;

import com.shopflow.billing.domain.Invoice;
import com.shopflow.billing.domain.InvoiceStatus;
import com.shopflow.billing.messaging.PaymentResultPublisher;
import com.shopflow.billing.payment.PaymentOutcome;
import com.shopflow.billing.payment.PaymentProvider;
import com.shopflow.billing.repository.InvoiceRepository;
import com.shopflow.events.OrderPlacedMessage;
import com.shopflow.events.PaymentResultMessage;
import java.util.List;
import java.util.Optional;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional
public class InvoiceService {

    private final InvoiceRepository invoiceRepository;
    private final InvoiceFactory invoiceFactory;
    private final PaymentProvider paymentProvider;
    private final PaymentResultPublisher results;

    public InvoiceService(InvoiceRepository invoiceRepository, InvoiceFactory invoiceFactory, PaymentProvider paymentProvider, PaymentResultPublisher results) {
        this.invoiceRepository = invoiceRepository;
        this.invoiceFactory = invoiceFactory;
        this.paymentProvider = paymentProvider;
        this.results = results;
    }

    public Invoice invoiceAndCharge(OrderPlacedMessage order) {
        if (invoiceRepository.findByOrderId(order.orderId()).isPresent()) {
            return invoiceRepository.findByOrderId(order.orderId()).get();
        }
        Invoice invoice = invoiceRepository.save(invoiceFactory.from(order));
        PaymentOutcome outcome = paymentProvider.charge(invoice.getCustomerEmail(), invoice.getGross(), invoice.getCurrency());
        invoice.setStatus(outcome.success() ? InvoiceStatus.PAID : InvoiceStatus.FAILED);
        invoice.setPaymentReference(outcome.reference());
        results.publish(new PaymentResultMessage(order.orderId(), invoice.getId(), outcome.success(), outcome.failureReason()));
        return invoice;
    }

    public void voidFor(Long orderId) {
        invoiceRepository.findByOrderId(orderId).ifPresent(invoice -> invoice.setStatus(InvoiceStatus.VOID));
    }

    @Transactional(readOnly = true)
    public List<Invoice> list() {
        return invoiceRepository.findAllByOrderByIssuedAtDesc();
    }

    @Transactional(readOnly = true)
    public Optional<Invoice> get(Long id) {
        return invoiceRepository.findById(id);
    }

    @Transactional(readOnly = true)
    public Optional<Invoice> forOrder(Long orderId) {
        return invoiceRepository.findByOrderId(orderId);
    }
}
