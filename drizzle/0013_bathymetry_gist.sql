-- Spatial index for bathymetry rasters; queries filter with ST_ConvexHull(rast) && <geometry>.
CREATE INDEX "bathymetry_rast_convexhull_gist" ON "bathymetry" USING gist (ST_ConvexHull("rast"));
