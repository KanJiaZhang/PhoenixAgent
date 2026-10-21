-- 注入错误 1：外键指错父表列。
-- 这份 DDL 看起来很像真的：表名、列名、类型、注释都在，只有最后一行把 region_id 指向了 dim_region.region_name
-- （编码对名称，0 命中）。目录（catalog）查不出这个错误，只有 references 探针跑一次 join 才看得出来。
CREATE TABLE fact_ad_daily (
  date_key       DATE         NOT NULL COMMENT '投放日期（自然日）',
  region_id      INTEGER      NOT NULL COMMENT '大区',
  industry_id    INTEGER      NOT NULL COMMENT '行业',
  channel_id     INTEGER      NOT NULL COMMENT '渠道',
  impressions    BIGINT       NOT NULL DEFAULT 0 COMMENT '曝光次数',
  clicks         BIGINT       NOT NULL DEFAULT 0 COMMENT '点击次数',
  spend          DECIMAL(15,2) NOT NULL DEFAULT 0 COMMENT '投放花费（元，媒体口径，不含返点）',
  revenue        DECIMAL(15,2) NOT NULL DEFAULT 0 COMMENT '归因收入（元，7 天点击归因窗口）',
  conversions    INTEGER      NOT NULL DEFAULT 0 COMMENT '转化数（下单且支付成功）',
  new_customers  INTEGER      NOT NULL DEFAULT 0 COMMENT '新客数（首单客户）',
  PRIMARY KEY (date_key, region_id, industry_id, channel_id),
  FOREIGN KEY (region_id) REFERENCES dim_region (region_name)
) COMMENT '投放日粒度事实表（含一处错误的外键：大区编码指向了大区名称）';
