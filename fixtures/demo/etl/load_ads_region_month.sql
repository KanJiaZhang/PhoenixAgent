-- ADS 装载：把事实表汇总进 ads_region_month。
-- 这不是一个报表，是一个 ETL 作业——它说明"ads_region_month 的口径来自哪里"，
-- 所以语义层要为它建 writes 关系（查询 → 目标表），而不是把它当成一个可问数的查询。

INSERT INTO ads_region_month (stat_month, region_id, spend, revenue)
SELECT
  substr(f.date_key, 1, 7)  AS stat_month,
  f.region_id               AS region_id,
  SUM(f.spend)              AS spend,
  SUM(f.revenue)            AS revenue
FROM fact_ad_daily f
GROUP BY substr(f.date_key, 1, 7), f.region_id;
