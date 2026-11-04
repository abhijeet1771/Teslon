create table invoices (
    id bigserial primary key,
    order_id bigint not null unique,
    number varchar(30) not null,
    customer_email varchar(200) not null,
    net numeric(12, 2) not null,
    tax numeric(12, 2) not null,
    gross numeric(12, 2) not null,
    currency varchar(3) not null,
    status varchar(20) not null,
    issued_at timestamp not null,
    payment_reference varchar(100)
);
