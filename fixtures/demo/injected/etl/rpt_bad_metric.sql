-- 注入错误 2：指标表达式里的列名拼错（revenuee）。
-- 列不存在，指标不可执行。只有把表达式拿回真实数据上验证才会失败——
-- 这也是为什么"生成候选"和"验证候选"必须是两个步骤。
SELECT
  r.region_name                    AS region,
  SUM(f.spend)                     AS spend,
  SUM(f.revenuee)                  AS revenue_typo
FROM fact_ad_daily f
JOIN dim_region r ON f.region_id = r.region_id
GROUP BY r.region_name;
