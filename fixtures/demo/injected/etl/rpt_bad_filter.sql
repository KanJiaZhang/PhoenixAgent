-- 注入错误 4：口径字面量拼错（'paidd'）。
-- 指标能跑、结果恒为 0，看起来像"那天没有成交"——这正是最危险的一类错：
-- 只有 enum 探针（看看这个字面量到底匹配几行）能把它揪出来。
SELECT
  r.region_name                     AS region,
  SUM(o.amount - o.refund_amount)    AS gmv_bad_filter
FROM fact_order o
JOIN dim_region r ON o.region_id = r.region_id
WHERE o.status = 'paidd'
GROUP BY r.region_name;
