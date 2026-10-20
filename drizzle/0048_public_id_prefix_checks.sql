-- A public id belongs to the id family of its object's type (spec 02; PUBLIC_ID_PREFIX in lib/domain/gazetteer/store.ts):
-- ar_ for areas, rg_ for islands, archipelagos, coast sections, gulfs and channels, hl_ for POIs, none for any other
-- type. A type change into another family gets a new id (gesamt-review DAT-3), so no package carries an id the
-- contract refuses. Places carry sp_ ids only.
ALTER TABLE geo_objects ADD CONSTRAINT geo_objects_public_id_prefix_check CHECK (
  public_id is null or public_id like (case
    when type = 'area' then 'ar\_%'
    when type in ('island', 'archipelago', 'coast_section', 'gulf', 'channel') then 'rg\_%'
    when type = 'poi' then 'hl\_%'
    else ''
  end)
);
--> statement-breakpoint
ALTER TABLE places ADD CONSTRAINT places_public_id_prefix_check CHECK (public_id is null or public_id like 'sp\_%');
