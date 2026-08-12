BEGIN;

CREATE OR REPLACE FUNCTION mbox.seed_store_permission_definitions()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO mbox.staff_permission_definitions (
    tenant_id, store_id, code, name, category, description, status
  )
  SELECT NEW.tenant_id, NEW.id, permission.code, permission.name,
    permission.category, permission.description, 'active'
  FROM (VALUES
    ('order.create', '创建订单', 'commerce', '为已开桌次创建并提交订单'),
    ('order.view', '查看订单', 'commerce', '查看职责范围内的订单和履约状态'),
    ('order.discount', '订单折扣', 'commerce', '在审批额度和规则内应用订单折扣'),
    ('order.gift', '赠送商品', 'commerce', '在审批额度和规则内赠送商品并记录原因'),
    ('kds.prepare', '制作出品', 'fulfillment', '接单并制作职责岗位的出品任务'),
    ('kds.deliver', '配送出品', 'fulfillment', '领取已完成出品并确认送达'),
    ('kds.exception.manage', '处理出品异常', 'fulfillment', '登记或处理取消、失败和重做等出品异常'),
    ('kds.priority.override', '调整出品优先级', 'fulfillment', '经授权调整出品优先级并保留审计'),
    ('payment.initiate.staff', '发起现场支付', 'payment', '为员工协助订单发起收款'),
    ('payment.manual.cash.record', '登记现金收款', 'payment', '人工核验后登记现金收款凭证'),
    ('payment.manual.pos.record', '登记物理POS收款', 'payment', '人工核验后登记物理POS收款凭证'),
    ('refund.request', '申请退款', 'payment', '发起退款申请但不能自行审批'),
    ('refund.approve', '审批退款', 'payment', '人工审批或拒绝退款申请'),
    ('refund.execute', '执行退款', 'payment', '对已审批退款发起支付渠道退款'),
    ('reservation.view', '查看预约', 'reservation', '查看本人或数据范围内的预约'),
    ('reservation.manage', '管理预约', 'reservation', '新建、修改、确认、到店及取消预约'),
    ('reservation.config.manage', '配置预约规则', 'reservation', '配置可预约范围、定金和最低消费规则'),
    ('song.view', '查看演出点歌', 'performance', '查看当天演出、歌手与点歌进度'),
    ('song.manage', '管理演出点歌', 'performance', '配置歌手、排班、歌单和处理点歌请求'),
    ('service.view', '查看服务任务', 'service', '查看职责范围内的服务任务'),
    ('service.execute', '执行服务任务', 'service', '创建并完成职责范围内的服务任务'),
    ('service.manage', '管理服务任务', 'service', '调度、升级、取消和接管服务任务'),
    ('fulfillment.view_all', '查看全部履约', 'fulfillment', '查看吧台、后厨及配送的全店履约进度')
  ) AS permission(code, name, category, description)
  ON CONFLICT (tenant_id, store_id, code) DO UPDATE
  SET name = EXCLUDED.name,
      category = EXCLUDED.category,
      description = EXCLUDED.description,
      status = 'active';
  RETURN NEW;
END;
$$;

CREATE TRIGGER stores_seed_permission_definitions
  AFTER INSERT ON mbox.stores
  FOR EACH ROW EXECUTE FUNCTION mbox.seed_store_permission_definitions();

INSERT INTO mbox.staff_permission_definitions (
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, permission.code, permission.name,
  permission.category, permission.description, 'active'
FROM mbox.stores AS store
CROSS JOIN (VALUES
  ('order.create', '创建订单', 'commerce', '为已开桌次创建并提交订单'),
  ('order.view', '查看订单', 'commerce', '查看职责范围内的订单和履约状态'),
  ('order.discount', '订单折扣', 'commerce', '在审批额度和规则内应用订单折扣'),
  ('order.gift', '赠送商品', 'commerce', '在审批额度和规则内赠送商品并记录原因'),
  ('kds.prepare', '制作出品', 'fulfillment', '接单并制作职责岗位的出品任务'),
  ('kds.deliver', '配送出品', 'fulfillment', '领取已完成出品并确认送达'),
  ('kds.exception.manage', '处理出品异常', 'fulfillment', '登记或处理取消、失败和重做等出品异常'),
  ('kds.priority.override', '调整出品优先级', 'fulfillment', '经授权调整出品优先级并保留审计'),
  ('payment.initiate.staff', '发起现场支付', 'payment', '为员工协助订单发起收款'),
  ('payment.manual.cash.record', '登记现金收款', 'payment', '人工核验后登记现金收款凭证'),
  ('payment.manual.pos.record', '登记物理POS收款', 'payment', '人工核验后登记物理POS收款凭证'),
  ('refund.request', '申请退款', 'payment', '发起退款申请但不能自行审批'),
  ('refund.approve', '审批退款', 'payment', '人工审批或拒绝退款申请'),
  ('refund.execute', '执行退款', 'payment', '对已审批退款发起支付渠道退款'),
  ('reservation.view', '查看预约', 'reservation', '查看本人或数据范围内的预约'),
  ('reservation.manage', '管理预约', 'reservation', '新建、修改、确认、到店及取消预约'),
  ('reservation.config.manage', '配置预约规则', 'reservation', '配置可预约范围、定金和最低消费规则'),
  ('song.view', '查看演出点歌', 'performance', '查看当天演出、歌手与点歌进度'),
  ('song.manage', '管理演出点歌', 'performance', '配置歌手、排班、歌单和处理点歌请求'),
  ('service.view', '查看服务任务', 'service', '查看职责范围内的服务任务'),
  ('service.execute', '执行服务任务', 'service', '创建并完成职责范围内的服务任务'),
  ('service.manage', '管理服务任务', 'service', '调度、升级、取消和接管服务任务'),
  ('fulfillment.view_all', '查看全部履约', 'fulfillment', '查看吧台、后厨及配送的全店履约进度')
) AS permission(code, name, category, description)
ON CONFLICT (tenant_id, store_id, code) DO UPDATE
SET name = EXCLUDED.name,
    category = EXCLUDED.category,
    description = EXCLUDED.description,
    status = 'active';

COMMENT ON FUNCTION mbox.seed_store_permission_definitions() IS
  'Seeds the canonical staff permission catalog for every newly provisioned store.';

COMMIT;
