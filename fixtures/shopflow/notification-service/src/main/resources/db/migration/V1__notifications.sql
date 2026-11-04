create table notifications (
    id bigserial primary key,
    order_id bigint not null,
    recipient varchar(200) not null,
    kind varchar(30) not null,
    subject varchar(300) not null,
    sent_at timestamp not null,
    status varchar(20) not null
);
