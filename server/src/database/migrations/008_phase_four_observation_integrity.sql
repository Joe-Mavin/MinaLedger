-- Phase 4 observation writes must target an open trade's current proposal line.
-- The trigger lock order matches the service: gold_trade, then gold_trade_line.

CREATE FUNCTION validate_phase_four_observation_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  observation_line_id UUID;
  observation_trade_id UUID;
  observation_trade_status TEXT;
  observation_line_is_current BOOLEAN;
BEGIN
  IF TG_TABLE_NAME='assay_record' THEN
    observation_line_id := NEW.gold_trade_line_id;
  ELSE
    SELECT measurement_set.gold_trade_line_id INTO observation_line_id
    FROM material_measurement_set measurement_set
    WHERE measurement_set.id=NEW.measurement_set_id;
  END IF;

  -- Non-Phase-4 assays and measurements keep their existing rules.
  IF observation_line_id IS NULL THEN RETURN NEW; END IF;

  SELECT line.trade_id INTO observation_trade_id
  FROM gold_trade_line line WHERE line.id=observation_line_id;
  IF observation_trade_id IS NULL THEN RETURN NEW; END IF;

  SELECT trade.status INTO observation_trade_status
  FROM gold_trade trade WHERE trade.id=observation_trade_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT line.is_current INTO observation_line_is_current
  FROM gold_trade_line line
  WHERE line.id=observation_line_id AND line.trade_id=observation_trade_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF observation_trade_status='CLOSED' THEN
    RAISE EXCEPTION 'closed gold trades cannot receive new observations' USING ERRCODE='23514';
  END IF;
  IF NOT observation_line_is_current THEN
    RAISE EXCEPTION 'gold trade observations must reference the current proposal line' USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER phase_four_observation_state_guard
  BEFORE INSERT ON assay_record
  FOR EACH ROW EXECUTE FUNCTION validate_phase_four_observation_state();

CREATE TRIGGER phase_four_observation_state_guard
  BEFORE INSERT ON material_measurement
  FOR EACH ROW EXECUTE FUNCTION validate_phase_four_observation_state();
