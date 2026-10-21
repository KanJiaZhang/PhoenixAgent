-- 报表层与视图：企业里语义层的另一半来源。
-- 视图是"已经有人写好的口径"，ADS 表是"ETL 落下来的口径"——两者都应该进语义层，而不是只读基表。

CREATE TABLE dim_campaign (
  campaign_id   INTEGER      NOT NULL,
  campaign_name VARCHAR(64)  NOT NULL COMMENT '投放计划名称',
  objective     VARCHAR(16)  COMMENT '投放目标（拉新/复购/清库存）',
  PRIMARY KEY (campaign_id)
) COMMENT '投放计划维度';

CREATE TABLE ads_region_month (
  stat_month    VARCHAR(7)   NOT NULL COMMENT '统计月份（YYYY-MM）',
  region_id     INTEGER      NOT NULL COMMENT '大区编码',
  spend         DECIMAL(15,2) COMMENT '当月投放花费',
  revenue       DECIMAL(15,2) COMMENT '当月归因收入',
  PRIMARY KEY (stat_month, region_id)
) COMMENT 'ADS 层大区月报：由 ETL 从事实表汇总写入，不直接对外查询';

CREATE VIEW v_ad_region_daily AS
SELECT
  f.date_key          AS stat_date,
  r.region_name       AS region,
  c.channel_name      AS channel,
  SUM(f.spend)        AS ad_spend,
  SUM(f.revenue)      AS ad_revenue,
  SUM(f.conversions)  AS ad_conversions
FROM fact_ad_daily f
JOIN dim_region r   ON f.region_id = r.region_id
JOIN dim_channel c  ON f.channel_id = c.channel_id
GROUP BY f.date_key, r.region_name, c.channel_name;
