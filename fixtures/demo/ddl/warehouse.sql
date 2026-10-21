-- 投放分析数仓：维度表、投放日粒度事实表、订单事实表。
-- 这份 DDL 是语义层的物理来源之一：列注释进入候选描述的证据，主外键进入 references 关系候选。
-- SQLite 可执行的写法（数据加载用它），MySQL 风格的注释与 COMMENT 由解析器读取。

CREATE TABLE dim_region (
  region_id     INTEGER      NOT NULL,
  region_name   VARCHAR(32)  NOT NULL COMMENT '大区名称（华东/华南/华北/西南）',
  country       VARCHAR(32)  NOT NULL DEFAULT 'CN' COMMENT '所属国家',
  PRIMARY KEY (region_id)
) COMMENT '大区维度：投放与订单的共同归属维度';

CREATE TABLE dim_industry (
  industry_id   INTEGER      NOT NULL,
  industry_name VARCHAR(32)  NOT NULL COMMENT '行业名称（母婴/3C数码/美妆个护）',
  sector        VARCHAR(32)  COMMENT '行业大类',
  PRIMARY KEY (industry_id)
) COMMENT '行业维度：决定投放素材与人群策略';

CREATE TABLE dim_channel (
  channel_id    INTEGER      NOT NULL,
  channel_name  VARCHAR(32)  NOT NULL COMMENT '渠道名称（搜索/信息流/直播）',
  channel_type  VARCHAR(16)  COMMENT '渠道类型（竞价/内容）',
  PRIMARY KEY (channel_id)
) COMMENT '投放渠道维度';

CREATE TABLE fact_ad_daily (
  date_key      DATE         NOT NULL COMMENT '投放日期（自然日）',
  region_id     INTEGER      NOT NULL COMMENT '大区',
  industry_id   INTEGER      NOT NULL COMMENT '行业',
  channel_id    INTEGER      NOT NULL COMMENT '渠道',
  campaign_id   INTEGER      NOT NULL COMMENT '投放计划（本表未声明外键，由语义层从命名与数据发现）',
  impressions   BIGINT       NOT NULL DEFAULT 0 COMMENT '曝光次数',
  clicks        BIGINT       NOT NULL DEFAULT 0 COMMENT '点击次数',
  spend         DECIMAL(15,2) NOT NULL DEFAULT 0 COMMENT '投放花费（元，媒体口径，不含返点）',
  revenue       DECIMAL(15,2) NOT NULL DEFAULT 0 COMMENT '归因收入（元，7 天点击归因窗口）',
  conversions   INTEGER      NOT NULL DEFAULT 0 COMMENT '转化数（下单且支付成功）',
  new_customers INTEGER      NOT NULL DEFAULT 0 COMMENT '新客数（首单客户）',
  PRIMARY KEY (date_key, region_id, industry_id, channel_id),
  FOREIGN KEY (region_id)   REFERENCES dim_region (region_id),
  FOREIGN KEY (industry_id) REFERENCES dim_industry (industry_id),
  FOREIGN KEY (channel_id)  REFERENCES dim_channel (channel_id)
) COMMENT '投放日粒度事实表：花费、归因收入、转化与新客';

CREATE TABLE fact_order (
  order_id      VARCHAR(32)  NOT NULL,
  order_date    DATE         NOT NULL COMMENT '下单日期',
  region_id     INTEGER      NOT NULL COMMENT '大区',
  industry_id   INTEGER      NOT NULL COMMENT '行业',
  amount        DECIMAL(15,2) NOT NULL COMMENT '订单金额（元，应付）',
  refund_amount DECIMAL(15,2) NOT NULL DEFAULT 0 COMMENT '退款金额（元）',
  status        VARCHAR(16)  NOT NULL COMMENT '订单状态（paid/refunded/pending）',
  PRIMARY KEY (order_id),
  FOREIGN KEY (region_id)   REFERENCES dim_region (region_id),
  FOREIGN KEY (industry_id) REFERENCES dim_industry (industry_id),
  INDEX idx_order_date (order_date),
  INDEX idx_status (status)
) COMMENT '订单事实表：GMV 的物理来源';
