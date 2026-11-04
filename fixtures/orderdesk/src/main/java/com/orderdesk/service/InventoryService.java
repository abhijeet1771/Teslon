package com.orderdesk.service;

import com.orderdesk.domain.Product;
import com.orderdesk.repository.ProductRepository;
import org.springframework.stereotype.Service;

@Service
public class InventoryService {

    private final ProductRepository products;

    public InventoryService(ProductRepository products) {
        this.products = products;
    }

    public void reserve(Product product, int quantity) {
        if (product.getStock() < quantity) {
            throw new IllegalStateException("Not enough stock for " + product.getSku());
        }
        product.setStock(product.getStock() - quantity);
        products.save(product);
    }

    public void release(Product product, int quantity) {
        product.setStock(product.getStock() + quantity);
        products.save(product);
    }
}
