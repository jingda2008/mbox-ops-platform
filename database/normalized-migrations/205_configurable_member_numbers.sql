BEGIN;
ALTER TABLE mbox.customer_memberships DROP CONSTRAINT customer_memberships_member_no_check;
ALTER TABLE mbox.customer_memberships ADD CONSTRAINT customer_memberships_member_no_check
 CHECK(member_no ~ '^MBX[0-9A-Z-]{6,32}$' OR member_no ~ '^[A-Z]{0,4}[0-9]{1,12}$');
CREATE TABLE mbox.member_number_policies(
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 width integer NOT NULL DEFAULT 6 CHECK(width BETWEEN 4 AND 12),
 start_number bigint NOT NULL DEFAULT 100001 CHECK(start_number>0),
 pad_zero boolean NOT NULL DEFAULT true,
 alphabet text NOT NULL DEFAULT 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' CHECK(alphabet ~ '^[A-Z]{1,26}$'),
 maximum_prefix_length integer NOT NULL DEFAULT 2 CHECK(maximum_prefix_length BETWEEN 0 AND 4),
 next_ordinal bigint NOT NULL DEFAULT 0 CHECK(next_ordinal>=0),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,store_id),FOREIGN KEY(tenant_id,store_id) REFERENCES mbox.stores(tenant_id,id),
 CHECK(start_number<power(10::numeric,width)),CHECK(width-maximum_prefix_length>=2)
);
ALTER TABLE mbox.member_number_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE mbox.member_number_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_store_isolation ON mbox.member_number_policies
 USING(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id())
 WITH CHECK(tenant_id=mbox.current_tenant_id() AND store_id=mbox.current_store_id());
REVOKE ALL ON mbox.member_number_policies FROM PUBLIC,mbox_runtime;
GRANT SELECT,INSERT,UPDATE ON mbox.member_number_policies TO mbox_runtime;
UPDATE mbox.normalized_schema_metadata SET schema_version='205',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
