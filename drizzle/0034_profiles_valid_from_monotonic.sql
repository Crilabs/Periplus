-- A profile version never starts before an earlier version of the same object: profile_as_of reads by valid_from, so a
-- backdated version would silently rewrite history. Writers use greatest(run date, previous valid_from) (ruling M5-A-R2).
CREATE FUNCTION profiles_valid_from_monotonic() RETURNS trigger AS $$
DECLARE
  latest date;
BEGIN
  SELECT max(valid_from) INTO latest FROM profiles WHERE geo_object_id = NEW.geo_object_id;
  IF latest IS NOT NULL AND NEW.valid_from < latest THEN
    RAISE EXCEPTION 'profiles.valid_from % precedes the latest valid_from % of geo object %', NEW.valid_from, latest, NEW.geo_object_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER profiles_valid_from_monotonic BEFORE INSERT ON profiles
  FOR EACH ROW EXECUTE FUNCTION profiles_valid_from_monotonic();
