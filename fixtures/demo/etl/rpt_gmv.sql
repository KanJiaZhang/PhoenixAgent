-- GMV 月报：已支付订单的净成交额（扣退款）。
-- 这里的 WHERE status = 'paid' 不是可选条件，它是指标口径的一部分。

SELECT
  substr(o.order_date, 1, 7)          AS stat_month,
  r.region_name                       AS region,
  i.industry_name                     AS industry,
  SUM(o.amount - o.refund_amount)     AS gmv,
  SUM(o.amount)                       AS paid_amount,
  SUM(o.refund_amount)                AS refunded_amount,
  COUNT(DISTINCT o.order_id)          AS paid_orders
FROM fact_order o
JOIN dim_region r   ON o.region_id = r.region_id
JOIN dim_industry i ON o.industry_id = i.industry_id
WHERE o.status = 'paid'
GROUP BY substr(o.order_date, 1, 7), r.region_name, i.industry_name;
