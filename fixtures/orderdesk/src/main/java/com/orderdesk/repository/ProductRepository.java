package com.orderdesk.repository;

import com.orderdesk.domain.Product;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;

public interface ProductRepository extends JpaRepository<Product, Long> {
    List<Product> findByStockLessThan(int threshold);
}
