# Postgres for Periplus: PostGIS (incl. raster) plus pgvector.
# Built on the official postgres image (multi-arch, PGDG apt repository preconfigured) because
# postgis/postgis publishes no arm64 images. The same image runs in dev, CI and production.
FROM postgres:17-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       postgresql-17-postgis-3 \
       postgresql-17-postgis-3-scripts \
       postgis \
       postgresql-17-pgvector \
  && rm -rf /var/lib/apt/lists/*

# ST_FromGDALRaster / ST_AsGDALRaster (bathymetry import) need the GTiff driver; PostGIS disables all
# GDAL drivers by default.
ENV POSTGIS_GDAL_ENABLED_DRIVERS=GTiff

COPY init/ /docker-entrypoint-initdb.d/
