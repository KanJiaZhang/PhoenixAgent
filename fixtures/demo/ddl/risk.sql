-- 风控语料：事件、标签、特征仓、已有规则。
-- 这份 DDL 的存在理由是"特征有效性和规则回测必须能在真实数据上跑"：
-- 有标签（is_fraud + label_date）、有特征快照（as_of_date 决定它是不是未来函数）、有已上线规则（用于增量对比）。

CREATE TABLE risk_event (
  event_id      VARCHAR(32)  NOT NULL COMMENT '交易/登录事件 id',
  event_date    DATE         NOT NULL COMMENT '事件发生日期',
  region_id     INTEGER      NOT NULL COMMENT '大区（复用 dim_region）',
  channel_id    INTEGER      NOT NULL COMMENT '渠道（复用 dim_channel）',
  amount        DECIMAL(15,2) NOT NULL COMMENT '交易金额',
  account_id    VARCHAR(32)  NOT NULL COMMENT '账户 id：实体图里的 Account 节点',
  device_id     VARCHAR(32)  NOT NULL COMMENT '设备 id：Account-[UsesDevice]->Device',
  ip_id         VARCHAR(32)  NOT NULL COMMENT 'IP id：Device-[SharesIp]->Ip',
  is_fraud      INTEGER      NOT NULL COMMENT '是否欺诈（调查结论，0/1）',
  label_date    DATE         NOT NULL COMMENT '标签确认日期：一定晚于事件日期',
  PRIMARY KEY (event_id)
) COMMENT '风控事件：标签在事件之后才能被确认，这是 point-in-time 的来源；account/device/ip 三列是实体图的边，图特征靠它们才可能存在';

CREATE TABLE feature_registry (
  feature_name       VARCHAR(64) NOT NULL,
  entity             VARCHAR(32) NOT NULL COMMENT '特征主体（account/device/event）',
  window             VARCHAR(16) COMMENT '统计窗口（7d/30d/snapshot）',
  data_type          VARCHAR(16) COMMENT 'numeric/bool/score',
  owner              VARCHAR(32) COMMENT '负责人',
  freshness_hours    INTEGER     COMMENT '允许的最大滞后小时数',
  coverage           DECIMAL(6,4) COMMENT '该特征在事件集上的非空覆盖率',
  available_before_event INTEGER NOT NULL COMMENT '1=事件前可算；0=用到事后信息（未来函数）',
  PRIMARY KEY (feature_name)
) COMMENT '特征仓注册表：可用时点是元数据，必须与快照的 as_of_date 一致';

CREATE TABLE feature_snapshot (
  event_id     VARCHAR(32)  NOT NULL,
  feature_name VARCHAR(64)  NOT NULL,
  as_of_date   DATE         NOT NULL COMMENT '该特征值在哪个日期被计算出来',
  value        DOUBLE       NOT NULL,
  PRIMARY KEY (event_id, feature_name)
) COMMENT '特征快照：使用条件必须是 as_of_date <= event_date';

CREATE TABLE risk_rule (
  rule_id     VARCHAR(16)  NOT NULL,
  expression  VARCHAR(256) NOT NULL COMMENT '规则表达式（SQL 谓词形式）',
  status      VARCHAR(16)  NOT NULL COMMENT 'active/draft/retired',
  owner       VARCHAR(32)  COMMENT '规则负责人',
  deployed_at DATE,
  PRIMARY KEY (rule_id)
) COMMENT '已上线规则：新规则必须与它们做增量对比';
