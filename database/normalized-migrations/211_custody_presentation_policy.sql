BEGIN;
ALTER TABLE mbox.bottle_custody_policies DROP CONSTRAINT bottle_custody_policies_send_minute_check;
ALTER TABLE mbox.bottle_custody_policies ADD CHECK(send_minute BETWEEN 0 AND 1439),
 ADD COLUMN print_fields text[] NOT NULL DEFAULT ARRAY['category','item','quantity','remaining','expiry','location','status','source'],
 ADD COLUMN print_footer text NOT NULL DEFAULT '取酒须通过会员验证码核验，本凭证不代替取走确认。',
 ADD COLUMN report_dimensions text[] NOT NULL DEFAULT ARRAY['category','status','date'];
ALTER TABLE mbox.bottle_custody_policies ADD CHECK(cardinality(print_fields)<=8 AND print_fields<@ARRAY['category','item','quantity','remaining','expiry','location','status','source']),
 ADD CHECK(length(print_footer)<=300),ADD CHECK(cardinality(report_dimensions)<=3 AND report_dimensions<@ARRAY['category','status','date']);
UPDATE mbox.normalized_schema_metadata SET schema_version='211',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
