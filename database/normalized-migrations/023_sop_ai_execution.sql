BEGIN;

CREATE TABLE mbox.sop_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 128),
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by_employee_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  UNIQUE (tenant_id, store_id, code),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.sop_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  sop_rule_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  trigger_event text NOT NULL CHECK (trigger_event ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  trigger_delay_ms bigint NOT NULL DEFAULT 0 CHECK (trigger_delay_ms BETWEEN 0 AND 2592000000),
  trigger_condition jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(trigger_condition) = 'object'),
  end_condition jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(end_condition) = 'object'),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  created_by_employee_id uuid NOT NULL,
  published_by_employee_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  retired_at timestamptz,
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, sop_rule_id)
    REFERENCES mbox.sop_rules(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, created_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, published_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (
    (status = 'draft' AND published_at IS NULL AND retired_at IS NULL)
    OR (status = 'published' AND published_at IS NOT NULL AND retired_at IS NULL
      AND published_by_employee_id IS NOT NULL)
    OR (status = 'retired' AND published_at IS NOT NULL AND retired_at IS NOT NULL
      AND published_by_employee_id IS NOT NULL)
  ),
  UNIQUE (tenant_id, store_id, sop_rule_id, version_number),
  UNIQUE (tenant_id, store_id, id)
);

CREATE UNIQUE INDEX sop_rule_versions_one_published_uq
  ON mbox.sop_rule_versions (tenant_id, store_id, sop_rule_id)
  WHERE status = 'published';
CREATE INDEX sop_rule_versions_trigger_idx
  ON mbox.sop_rule_versions (tenant_id, store_id, trigger_event, sop_rule_id)
  WHERE status = 'published';

CREATE TABLE mbox.sop_rule_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  sop_rule_version_id uuid NOT NULL,
  step_key text NOT NULL CHECK (step_key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  step_order integer NOT NULL CHECK (step_order BETWEEN 1 AND 1000),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 128),
  delay_ms bigint NOT NULL DEFAULT 0 CHECK (delay_ms BETWEEN 0 AND 2592000000),
  condition_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(condition_snapshot) = 'object'),
  action_name text NOT NULL CHECK (action_name ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  action_input jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(action_input) = 'object'),
  requested_role_code text,
  assigned_employee_id uuid,
  escalation_after_ms bigint CHECK (
    escalation_after_ms IS NULL OR escalation_after_ms BETWEEN 1000 AND 2592000000
  ),
  escalation_role_code text,
  escalation_employee_id uuid,
  end_condition jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(end_condition) = 'object'),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, sop_rule_version_id)
    REFERENCES mbox.sop_rule_versions(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, assigned_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, escalation_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (
    escalation_after_ms IS NOT NULL
    OR (escalation_role_code IS NULL AND escalation_employee_id IS NULL)
  ),
  UNIQUE (tenant_id, store_id, sop_rule_version_id, step_key),
  UNIQUE (tenant_id, store_id, sop_rule_version_id, step_order),
  UNIQUE (tenant_id, store_id, id)
);

CREATE TABLE mbox.sop_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  sop_rule_id uuid NOT NULL,
  sop_rule_version_id uuid NOT NULL,
  trigger_event text NOT NULL CHECK (trigger_event ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  trigger_reference text NOT NULL CHECK (length(btrim(trigger_reference)) BETWEEN 1 AND 256),
  business_date date NOT NULL,
  context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(context_snapshot) = 'object'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled', 'failed')),
  current_step_order integer NOT NULL DEFAULT 1 CHECK (current_step_order BETWEEN 1 AND 1001),
  aggregate_version bigint NOT NULL DEFAULT 1 CHECK (aggregate_version > 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, sop_rule_id)
    REFERENCES mbox.sop_rules(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, sop_rule_version_id)
    REFERENCES mbox.sop_rule_versions(tenant_id, store_id, id),
  CHECK (
    (status = 'active' AND completed_at IS NULL AND cancellation_reason IS NULL)
    OR (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
    OR (status = 'cancelled' AND completed_at IS NOT NULL
      AND length(btrim(cancellation_reason)) BETWEEN 2 AND 1000)
  ),
  UNIQUE (tenant_id, store_id, sop_rule_version_id, trigger_event, trigger_reference),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX sop_instances_status_idx
  ON mbox.sop_instances (tenant_id, store_id, status, business_date, started_at, id);

CREATE TABLE mbox.sop_step_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  sop_instance_id uuid NOT NULL,
  sop_rule_step_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'processing', 'waiting', 'completed', 'skipped', 'failed', 'cancelled'
  )),
  scheduled_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  worker_locked_by text,
  worker_locked_at timestamptz,
  external_reference text,
  output_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(output_snapshot) = 'object'),
  last_error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, sop_instance_id)
    REFERENCES mbox.sop_instances(tenant_id, store_id, id),
  FOREIGN KEY (tenant_id, store_id, sop_rule_step_id)
    REFERENCES mbox.sop_rule_steps(tenant_id, store_id, id),
  CHECK (
    (status IN ('completed', 'skipped', 'failed', 'cancelled') AND completed_at IS NOT NULL)
    OR (status IN ('pending', 'processing', 'waiting') AND completed_at IS NULL)
  ),
  UNIQUE (tenant_id, store_id, sop_instance_id, sop_rule_step_id),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX sop_step_executions_due_idx
  ON mbox.sop_step_executions (
    tenant_id, store_id, next_attempt_at, scheduled_at, id
  ) WHERE status IN ('pending', 'waiting');

CREATE TABLE mbox.ai_execution_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  store_id uuid NOT NULL,
  requested_by_employee_id uuid NOT NULL,
  tool_name text NOT NULL CHECK (tool_name ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  arguments_snapshot jsonb NOT NULL CHECK (jsonb_typeof(arguments_snapshot) = 'object'),
  status text NOT NULL CHECK (status IN (
    'needs_clarification', 'requires_confirmation', 'scheduled', 'processing',
    'succeeded', 'failed', 'cancelled'
  )),
  requires_human_confirmation boolean NOT NULL DEFAULT false,
  run_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  candidate_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(candidate_snapshot) = 'array'),
  result_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(result_snapshot) = 'object'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  worker_locked_by text,
  worker_locked_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, store_id) REFERENCES mbox.stores(tenant_id, id),
  FOREIGN KEY (tenant_id, store_id, requested_by_employee_id)
    REFERENCES mbox.employees(tenant_id, store_id, id),
  CHECK (
    (status IN ('succeeded', 'failed', 'cancelled') AND completed_at IS NOT NULL)
    OR (status NOT IN ('succeeded', 'failed', 'cancelled') AND completed_at IS NULL)
  ),
  UNIQUE (tenant_id, store_id, id)
);

CREATE INDEX ai_execution_requests_due_idx
  ON mbox.ai_execution_requests (tenant_id, store_id, run_at, created_at, id)
  WHERE status = 'scheduled';
CREATE INDEX ai_execution_requests_employee_idx
  ON mbox.ai_execution_requests (
    tenant_id, store_id, requested_by_employee_id, created_at DESC, id
  );

CREATE OR REPLACE FUNCTION mbox.protect_sop_definition()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version_status text;
BEGIN
  IF TG_TABLE_NAME = 'sop_rule_versions' THEN
    IF TG_OP = 'DELETE' AND OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'published SOP version is immutable' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
      IF NEW.status = 'retired' AND OLD.status = 'published'
        AND NEW.retired_at IS NOT NULL
        AND NEW.trigger_event = OLD.trigger_event
        AND NEW.trigger_delay_ms = OLD.trigger_delay_ms
        AND NEW.trigger_condition = OLD.trigger_condition
        AND NEW.end_condition = OLD.end_condition
        AND NEW.sop_rule_id = OLD.sop_rule_id
        AND NEW.version_number = OLD.version_number THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'published SOP version is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT status INTO version_status
  FROM mbox.sop_rule_versions
  WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
    AND store_id = COALESCE(NEW.store_id, OLD.store_id)
    AND id = COALESCE(NEW.sop_rule_version_id, OLD.sop_rule_version_id);
  IF version_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'steps of a published SOP version are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER sop_rule_versions_protect
  BEFORE UPDATE OR DELETE ON mbox.sop_rule_versions
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_sop_definition();
CREATE TRIGGER sop_rule_steps_protect
  BEFORE INSERT OR UPDATE OR DELETE ON mbox.sop_rule_steps
  FOR EACH ROW EXECUTE FUNCTION mbox.protect_sop_definition();

CREATE TRIGGER sop_rules_touch_updated_at
  BEFORE UPDATE ON mbox.sop_rules
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER sop_instances_touch_updated_at
  BEFORE UPDATE ON mbox.sop_instances
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER sop_step_executions_touch_updated_at
  BEFORE UPDATE ON mbox.sop_step_executions
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();
CREATE TRIGGER ai_execution_requests_touch_updated_at
  BEFORE UPDATE ON mbox.ai_execution_requests
  FOR EACH ROW EXECUTE FUNCTION mbox.touch_updated_at();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'sop_rules', 'sop_rule_versions', 'sop_rule_steps', 'sop_instances',
    'sop_step_executions', 'ai_execution_requests'
  ]
  LOOP
    EXECUTE format('ALTER TABLE mbox.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE mbox.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_store_isolation ON mbox.%I '
      'USING (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id()) '
      'WITH CHECK (tenant_id = mbox.current_tenant_id() AND store_id = mbox.current_store_id())',
      table_name
    );
    EXECUTE format('REVOKE ALL ON TABLE mbox.%I FROM PUBLIC', table_name);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  mbox.sop_rules, mbox.sop_rule_versions, mbox.sop_rule_steps
TO mbox_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE
  mbox.sop_instances, mbox.sop_step_executions, mbox.ai_execution_requests
TO mbox_runtime;

INSERT INTO mbox.staff_permission_definitions (
  tenant_id, store_id, code, name, category, description, status
)
SELECT store.tenant_id, store.id, permission.code, permission.name,
  permission.category, permission.description, 'active'
FROM mbox.stores AS store
CROSS JOIN (VALUES
  ('sop.view', '查看SOP', 'automation', '查看已发布SOP及执行进度'),
  ('sop.manage', '配置SOP', 'automation', '创建、发布和停用SOP规则'),
  ('sop.execute', '执行SOP', 'automation', '触发和处理SOP实例'),
  ('ai.execute', '使用AI执行能力', 'automation', '在本人实时权限范围内执行非财务AI工具'),
  ('ai.schedule', '安排延迟AI命令', 'automation', '在本人实时权限范围内安排延迟命令'),
  ('service.execute', '执行服务任务', 'service', '创建和处理本人权限范围内的服务任务'),
  ('refund.request', '申请退款', 'finance', '发起退款申请，不能替代人工审批'),
  ('refund.approve', '审批退款', 'finance', '人工审批退款申请'),
  ('cash.confirm', '确认现金收款', 'finance', '人工确认现场现金收款')
) AS permission(code, name, category, description)
ON CONFLICT (tenant_id, store_id, code) DO UPDATE
SET name = EXCLUDED.name,
    category = EXCLUDED.category,
    description = EXCLUDED.description,
    status = EXCLUDED.status;

COMMENT ON TABLE mbox.sop_rule_versions IS
  'Immutable after publication; steps, conditions, delays, assignment and escalation belong to the version.';
COMMENT ON TABLE mbox.sop_step_executions IS
  'Bounded worker queue. Claim due rows with FOR UPDATE SKIP LOCKED.';
COMMENT ON TABLE mbox.ai_execution_requests IS
  'Server-authorized AI tool execution evidence. The model can propose only; financial actions never auto-run.';

COMMIT;
