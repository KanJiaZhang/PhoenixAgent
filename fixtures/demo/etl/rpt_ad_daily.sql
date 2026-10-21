-- 投放日报：业务方每天看的报表。
-- 语义层从这里读到：指标（别名 + 聚合表达式）、口径过滤条件、维度（GROUP BY）、join 路径（ON 条件）。
-- CTE 只是把维度名拼上来，聚合仍然落在事实表上。

WITH ad AS (
  SELECT f.date_key, f.region_id, f.industry_id, f.channel_id,
         f.impressions, f.clicks, f.spend, f.revenue, f.conversions, f.new_customers
  FROM fact_ad_daily f
)
SELECT
  ad.date_key                                AS stat_date,
  r.region_name                              AS region,
  i.industry_name                            AS industry,
  c.channel_name                             AS channel,
  SUM(ad.spend)                              AS spend,
  SUM(ad.revenue)                            AS revenue,
  SUM(ad.impressions)                        AS impressions,
  SUM(ad.clicks)                             AS clicks,
  SUM(ad.conversions)                        AS conversions,
  SUM(ad.new_customers)                      AS new_customers,
  SUM(ad.revenue) * 1.0 / NULLIF(SUM(ad.spend), 0) AS roi,
  SUM(ad.spend) * 1.0 / NULLIF(SUM(ad.conversions), 0) AS cpa,
  SUM(ad.conversions) * 1.0 / NULLIF(SUM(ad.clicks), 0) AS conversion_rate
FROM ad
JOIN dim_region r   ON ad.region_id = r.region_id
JOIN dim_industry i ON ad.industry_id = i.industry_id
JOIN dim_channel c  ON ad.channel_id = c.channel_id
WHERE ad.date_key >= '2024-01-01'
GROUP BY ad.date_key, r.region_name, i.industry_name, c.channel_name;
