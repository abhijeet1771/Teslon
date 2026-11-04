package com.orderdesk.web.rest;

import com.orderdesk.service.ReportService;
import com.orderdesk.service.dto.DailySalesDto;
import java.time.LocalDate;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/reports")
public class ReportResource {

    private final ReportService reports;

    public ReportResource(ReportService reports) {
        this.reports = reports;
    }

    @GetMapping("/daily-sales")
    public DailySalesDto dailySales(@RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate day) {
        return reports.dailySales(day);
    }
}
