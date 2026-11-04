package com.shopflow.catalog.service;

import com.shopflow.catalog.domain.Product;
import com.shopflow.catalog.mapper.ProductMapper;
import com.shopflow.catalog.repository.ProductRepository;
import com.shopflow.catalog.web.ProductUpdateRequest;
import java.util.List;
import java.util.NoSuchElementException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@Transactional
public class ProductService {

    private final ProductRepository productRepository;
    private final ProductMapper productMapper;

    public ProductService(ProductRepository productRepository, ProductMapper productMapper) {
        this.productRepository = productRepository;
        this.productMapper = productMapper;
    }

    @Transactional(readOnly = true)
    public List<Product> active() {
        return productRepository.findByActiveTrueOrderByName();
    }

    @Transactional(readOnly = true)
    public Product bySku(String sku) {
        return productRepository.findBySku(sku).orElseThrow(() -> new NoSuchElementException(sku));
    }

    public Product update(String sku, ProductUpdateRequest request) {
        Product product = bySku(sku);
        productMapper.update(request, product);
        return product;
    }

    public void reserve(String sku, int quantity) {
        Product product = bySku(sku);
        product.setStock(Math.max(0, product.getStock() - quantity));
    }
}
