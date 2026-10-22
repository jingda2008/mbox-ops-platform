BEGIN;

CREATE TABLE mbox.product_service_windows (
  tenant_id uuid NOT NULL, store_id uuid NOT NULL, product_id uuid NOT NULL,
  card_project_id uuid,
  date_from date, date_through date,
  weekdays smallint[] NOT NULL,
  sale_start_minute smallint NOT NULL, sale_end_minute smallint NOT NULL,
  visible_start_minute smallint NOT NULL, visible_end_minute smallint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE NULLS NOT DISTINCT (tenant_id,store_id,product_id,card_project_id),
  FOREIGN KEY(tenant_id,store_id,product_id) REFERENCES mbox.products(tenant_id,store_id,id),
  FOREIGN KEY(tenant_id,store_id,card_project_id) REFERENCES mbox.member_card_projects(tenant_id,store_id,id),
  CHECK(date_from IS NULL OR date_through IS NULL OR date_through>=date_from),
  CHECK(cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  CHECK(sale_start_minute BETWEEN 0 AND 1439 AND sale_end_minute>sale_start_minute AND sale_end_minute<=sale_start_minute+1440),
  CHECK(visible_start_minute BETWEEN 0 AND 1439 AND visible_end_minute>visible_start_minute AND visible_end_minute<=visible_start_minute+1440),
  CHECK(visible_start_minute<=sale_start_minute AND visible_end_minute>=sale_end_minute)
);
ALTER TABLE mbox.product_service_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.product_service_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.product_service_windows
  USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
  WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.product_service_windows FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON mbox.product_service_windows TO mbox_runtime;

CREATE FUNCTION mbox.product_service_window_json(p_tenant uuid,p_store uuid,p_product uuid,p_project uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('dateFrom',w.date_from,'dateThrough',w.date_through,'weekdays',w.weekdays,
  'saleStartMinute',w.sale_start_minute,'saleEndMinute',w.sale_end_minute,'visibleStartMinute',w.visible_start_minute,'visibleEndMinute',w.visible_end_minute)
 FROM mbox.product_service_windows w WHERE w.tenant_id=p_tenant AND w.store_id=p_store AND w.product_id=p_product AND w.card_project_id IS NOT DISTINCT FROM p_project
$$;

-- A missing new rule preserves legacy behavior. NULL means outside the rule;
-- infinity means no new cutoff. Cross-midnight dates belong to the start day.
CREATE FUNCTION mbox.service_window_deadline(p_tenant uuid,p_store uuid,p_product uuid,p_project uuid,p_visible boolean,p_at timestamptz DEFAULT clock_timestamp())
RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE w mbox.product_service_windows%ROWTYPE; zone text; local_at timestamp; anchor date; minute numeric; start_min integer; end_min integer;
BEGIN
 SELECT * INTO w FROM mbox.product_service_windows WHERE tenant_id=p_tenant AND store_id=p_store AND product_id=p_product AND card_project_id IS NOT DISTINCT FROM p_project;
 IF NOT FOUND THEN RETURN 'infinity'::timestamptz; END IF;
 SELECT timezone INTO zone FROM mbox.stores WHERE tenant_id=p_tenant AND id=p_store;
 IF zone IS NULL THEN RETURN NULL; END IF;
 local_at:=p_at AT TIME ZONE zone; anchor:=local_at::date;
 minute:=extract(hour FROM local_at)*60+extract(minute FROM local_at)+extract(second FROM local_at)/60;
 start_min:=CASE WHEN p_visible THEN w.visible_start_minute ELSE w.sale_start_minute END;
 end_min:=CASE WHEN p_visible THEN w.visible_end_minute ELSE w.sale_end_minute END;
 IF end_min>1440 AND minute<start_min THEN anchor:=anchor-1;minute:=minute+1440;END IF;
 IF minute<start_min OR minute>=end_min OR (w.date_from IS NOT NULL AND anchor<w.date_from)
   OR (w.date_through IS NOT NULL AND anchor>w.date_through) OR NOT extract(isodow FROM anchor)::integer=ANY(w.weekdays) THEN RETURN NULL;END IF;
 RETURN (anchor::timestamp+make_interval(mins=>end_min)) AT TIME ZONE zone;
END $$;

CREATE FUNCTION mbox.product_base_service_deadline(p_tenant uuid,p_store uuid,p_product uuid,p_at timestamptz DEFAULT clock_timestamp())
RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE product mbox.products%ROWTYPE; zone text; local_at timestamp; anchor date; start_min integer;end_min integer;minute numeric;legacy_end timestamptz:='infinity';new_end timestamptz;
BEGIN
 SELECT * INTO product FROM mbox.products WHERE tenant_id=p_tenant AND store_id=p_store AND id=p_product;
 IF NOT FOUND THEN RETURN NULL;END IF;
 SELECT timezone INTO zone FROM mbox.stores WHERE tenant_id=p_tenant AND id=p_store;
 local_at:=p_at AT TIME ZONE zone;anchor:=local_at::date;
 IF product.available_from IS NOT NULL AND product.available_until IS NOT NULL THEN
  start_min:=extract(hour FROM product.available_from)*60+extract(minute FROM product.available_from);
  end_min:=extract(hour FROM product.available_until)*60+extract(minute FROM product.available_until);
  IF end_min<=start_min THEN end_min:=end_min+1440;END IF;
  minute:=extract(hour FROM local_at)*60+extract(minute FROM local_at)+extract(second FROM local_at)/60;
  IF end_min>1440 AND minute<start_min THEN anchor:=anchor-1;minute:=minute+1440;END IF;
  IF minute<start_min OR minute>=end_min THEN RETURN NULL;END IF;
  legacy_end:=(anchor::timestamp+make_interval(mins=>end_min)) AT TIME ZONE zone;
 END IF;
 new_end:=mbox.service_window_deadline(p_tenant,p_store,p_product,NULL,false,p_at);
 IF new_end IS NULL THEN RETURN NULL;END IF;
 RETURN LEAST(legacy_end,new_end);
END $$;

CREATE OR REPLACE FUNCTION mbox.customer_has_card_menu_item(p_tenant uuid,p_store uuid,p_product uuid,p_customer uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT p_customer IS NOT NULL AND EXISTS(
 SELECT 1 FROM mbox.member_card_menu_items mi
 WHERE mi.tenant_id=p_tenant AND mi.store_id=p_store AND mi.product_id=p_product AND mi.active AND mi.exclusive
 AND mbox.customer_has_usable_member_card(p_tenant,p_store,mi.project_id,p_customer,true)
 AND mbox.service_window_deadline(p_tenant,p_store,p_product,CASE WHEN EXISTS(SELECT 1 FROM mbox.product_service_windows w WHERE w.tenant_id=p_tenant AND w.store_id=p_store AND w.product_id=p_product AND w.card_project_id=mi.project_id) THEN mi.project_id ELSE NULL END,true) IS NOT NULL)
$$;

CREATE OR REPLACE FUNCTION mbox.customer_card_price(p_tenant uuid,p_store uuid,p_product uuid,p_customer uuid)
RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT min(mi.exclusive_price_minor) FROM mbox.member_card_menu_items mi
 WHERE mi.tenant_id=p_tenant AND mi.store_id=p_store AND mi.product_id=p_product AND mi.active
 AND mbox.customer_has_usable_member_card(p_tenant,p_store,mi.project_id,p_customer,true)
 AND mbox.product_base_service_deadline(p_tenant,p_store,p_product) IS NOT NULL
 AND mbox.service_window_deadline(p_tenant,p_store,p_product,mi.project_id,false) IS NOT NULL
$$;

CREATE FUNCTION mbox.product_visible_now(p_tenant uuid,p_store uuid,p_product uuid,p_customer uuid,p_at timestamptz DEFAULT clock_timestamp())
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE((SELECT (p.guest_visible AND mbox.service_window_deadline(p_tenant,p_store,p_product,NULL,true,p_at) IS NOT NULL)
 OR mbox.customer_has_card_menu_item(p_tenant,p_store,p_product,p_customer)
 FROM mbox.products p WHERE p.tenant_id=p_tenant AND p.store_id=p_store AND p.id=p_product),false)
$$;

CREATE FUNCTION mbox.product_purchase_deadline(p_tenant uuid,p_store uuid,p_product uuid,p_customer uuid,p_at timestamptz DEFAULT clock_timestamp())
RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE base_end timestamptz;card_end timestamptz;is_public boolean;has_exclusive boolean;
BEGIN
 base_end:=mbox.product_base_service_deadline(p_tenant,p_store,p_product,p_at);
 IF base_end IS NULL THEN RETURN NULL;END IF;
 SELECT guest_visible INTO is_public FROM mbox.products WHERE tenant_id=p_tenant AND store_id=p_store AND id=p_product;
 SELECT EXISTS(SELECT 1 FROM mbox.member_card_menu_items mi WHERE mi.tenant_id=p_tenant AND mi.store_id=p_store AND mi.product_id=p_product AND mi.exclusive) INTO has_exclusive;
 IF is_public OR NOT has_exclusive THEN RETURN base_end;END IF;
 SELECT max(LEAST(mbox.service_window_deadline(p_tenant,p_store,p_product,mi.project_id,false,p_at),COALESCE(card.valid_until,'infinity'::timestamptz))) INTO card_end
 FROM mbox.member_card_menu_items mi JOIN mbox.member_cards card ON card.tenant_id=mi.tenant_id AND card.store_id=mi.store_id AND card.project_id=mi.project_id
 WHERE mi.tenant_id=p_tenant AND mi.store_id=p_store AND mi.product_id=p_product AND mi.active AND mi.exclusive
 AND card.status='active' AND card.valid_from<=p_at AND (card.valid_until IS NULL OR card.valid_until>p_at)
 AND mbox.canonical_customer_id(card.tenant_id,card.store_id,card.customer_id)=mbox.canonical_customer_id(p_tenant,p_store,p_customer)
 AND mbox.customer_has_usable_member_card(p_tenant,p_store,mi.project_id,p_customer,true)
 AND mbox.service_window_deadline(p_tenant,p_store,p_product,mi.project_id,false,p_at) IS NOT NULL;
 IF card_end IS NULL THEN RETURN NULL;END IF;
 RETURN LEAST(base_end,card_end);
END $$;

CREATE FUNCTION mbox.product_quote_deadline(p_tenant uuid,p_store uuid,p_product uuid,p_customer uuid,p_amount bigint,p_card_price boolean,p_at timestamptz DEFAULT clock_timestamp())
RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE base_end timestamptz;card_end timestamptz;
BEGIN
 base_end:=mbox.product_purchase_deadline(p_tenant,p_store,p_product,p_customer,p_at);
 IF base_end IS NULL OR NOT p_card_price THEN RETURN base_end;END IF;
 SELECT max(LEAST(mbox.service_window_deadline(p_tenant,p_store,p_product,mi.project_id,false,p_at),COALESCE(card.valid_until,'infinity'::timestamptz))) INTO card_end
 FROM mbox.member_card_menu_items mi JOIN mbox.member_cards card ON card.tenant_id=mi.tenant_id AND card.store_id=mi.store_id AND card.project_id=mi.project_id
 WHERE mi.tenant_id=p_tenant AND mi.store_id=p_store AND mi.product_id=p_product AND mi.active AND mi.exclusive_price_minor=p_amount
 AND card.status='active' AND card.valid_from<=p_at AND (card.valid_until IS NULL OR card.valid_until>p_at)
 AND mbox.canonical_customer_id(card.tenant_id,card.store_id,card.customer_id)=mbox.canonical_customer_id(p_tenant,p_store,p_customer)
 AND mbox.customer_has_usable_member_card(p_tenant,p_store,mi.project_id,p_customer,true)
 AND mbox.service_window_deadline(p_tenant,p_store,p_product,mi.project_id,false,p_at) IS NOT NULL;
 IF card_end IS NULL THEN RETURN NULL;END IF;
 RETURN LEAST(base_end,card_end);
END $$;
REVOKE ALL ON FUNCTION mbox.product_quote_deadline(uuid,uuid,uuid,uuid,bigint,boolean,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.product_quote_deadline(uuid,uuid,uuid,uuid,bigint,boolean,timestamptz) TO mbox_runtime;

-- Only nine start dates are needed: dates outside this overlap are either
-- excluded by bounds or repeat the same weekday pattern.
CREATE FUNCTION mbox.product_service_windows_overlap(p_tenant uuid,p_store uuid,p_product uuid,p_project uuid)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE lower_day date;upper_day date;zone text;candidate record;moment timestamptz;
BEGIN
 SELECT timezone INTO zone FROM mbox.stores WHERE tenant_id=p_tenant AND id=p_store;
 SELECT GREATEST(COALESCE(max(date_from)-1,(clock_timestamp() AT TIME ZONE zone)::date),(clock_timestamp() AT TIME ZONE zone)::date),min(date_through)+1 INTO lower_day,upper_day
 FROM mbox.product_service_windows WHERE tenant_id=p_tenant AND store_id=p_store AND product_id=p_product AND (card_project_id IS NULL OR card_project_id=p_project);
 SELECT timezone INTO zone FROM mbox.stores WHERE tenant_id=p_tenant AND id=p_store;
 IF upper_day IS NOT NULL AND upper_day<lower_day THEN RETURN false;END IF;
 FOR candidate IN SELECT d::date AS anchor_day,m.clock_minute FROM generate_series(lower_day::timestamp,LEAST(COALESCE(upper_day,lower_day+8),lower_day+8)::timestamp,interval '1 day') d
 CROSS JOIN LATERAL (SELECT 0 AS clock_minute UNION SELECT sale_start_minute FROM mbox.product_service_windows WHERE tenant_id=p_tenant AND store_id=p_store AND product_id=p_product AND (card_project_id IS NULL OR card_project_id=p_project)
 UNION SELECT (extract(hour FROM available_from)*60+extract(minute FROM available_from))::integer FROM mbox.products WHERE tenant_id=p_tenant AND store_id=p_store AND id=p_product AND available_from IS NOT NULL) m
 LOOP
  moment:=(candidate.anchor_day::timestamp+make_interval(mins=>candidate.clock_minute)) AT TIME ZONE zone;
  IF mbox.product_base_service_deadline(p_tenant,p_store,p_product,moment) IS NOT NULL AND mbox.service_window_deadline(p_tenant,p_store,p_product,p_project,false,moment) IS NOT NULL THEN RETURN true;END IF;
 END LOOP;
 RETURN false;
END $$;

REVOKE ALL ON FUNCTION mbox.product_service_window_json(uuid,uuid,uuid,uuid),mbox.service_window_deadline(uuid,uuid,uuid,uuid,boolean,timestamptz),mbox.product_base_service_deadline(uuid,uuid,uuid,timestamptz),mbox.product_visible_now(uuid,uuid,uuid,uuid,timestamptz),mbox.product_purchase_deadline(uuid,uuid,uuid,uuid,timestamptz),mbox.product_service_windows_overlap(uuid,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mbox.product_service_window_json(uuid,uuid,uuid,uuid),mbox.service_window_deadline(uuid,uuid,uuid,uuid,boolean,timestamptz),mbox.product_base_service_deadline(uuid,uuid,uuid,timestamptz),mbox.product_visible_now(uuid,uuid,uuid,uuid,timestamptz),mbox.product_purchase_deadline(uuid,uuid,uuid,uuid,timestamptz),mbox.product_service_windows_overlap(uuid,uuid,uuid,uuid) TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='277',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
