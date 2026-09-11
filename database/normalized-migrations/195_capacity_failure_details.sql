BEGIN;
-- Preserve the existing capacity locking and limits; attach facts at rejection time.
DO $migration$ DECLARE definition text; BEGIN
 definition:=pg_get_functiondef('mbox.reserve_order_fulfillment_capacity(uuid,uuid,uuid)'::regprocedure);
 definition:=replace(definition,'SELECT window_value.id, window_value.capacity_limit_units INTO window_row','SELECT window_value.id, window_value.capacity_limit_units,window_value.starts_at,window_value.ends_at INTO window_row');
 definition:=replace(definition,$old$RAISE EXCEPTION 'fulfillment capacity exceeded for station %', item_row.fulfillment_station
        USING ERRCODE='23514';$old$,$new$RAISE EXCEPTION 'fulfillment capacity exceeded for station %', item_row.fulfillment_station
        USING ERRCODE='23514',DETAIL=jsonb_build_object('station',item_row.fulfillment_station,'startsAt',window_row.starts_at,'endsAt',window_row.ends_at,'capacity',window_row.capacity_limit_units,'used',used_units,'required',required_units)::text;$new$);
 EXECUTE definition;
 definition:=pg_get_functiondef('mbox.validate_fulfillment_capacity_reservation()'::regprocedure);
 definition:=replace(definition,$old$RAISE EXCEPTION 'fulfillment capacity exceeded for window %', NEW.capacity_window_id
        USING ERRCODE='23514';$old$,$new$RAISE EXCEPTION 'fulfillment capacity exceeded for window %', NEW.capacity_window_id
        USING ERRCODE='23514',DETAIL=jsonb_build_object('station',item_station,'startsAt',window_starts_at,'endsAt',window_ends_at,'capacity',window_limit,'used',used_units,'required',NEW.capacity_units)::text;$new$);
 EXECUTE definition;
END $migration$;
UPDATE mbox.normalized_schema_metadata SET schema_version='195',updated_at=clock_timestamp() WHERE singleton=true;
COMMIT;
