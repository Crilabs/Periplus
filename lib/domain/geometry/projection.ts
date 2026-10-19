/**
 * EPSG code of the WGS84 UTM zone containing the point: 326xx north of the equator, 327xx south of it.
 * A longitude exactly on a zone edge belongs to the eastern zone; longitude 180 stays in zone 60.
 */
export function utmSridFor(lon: number, lat: number): number {
  const zone = Math.min(Math.floor((lon + 180) / 6) + 1, 60);
  return (lat >= 0 ? 32600 : 32700) + zone;
}
