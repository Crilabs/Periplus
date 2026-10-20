/** Largest bbox side (degrees) a map-data request may ask for. Dependency-free: shared by server and client. */
export const MAX_BBOX_DEGREES = 5;

/** Rounding tolerance the server allows on top of the maximum side. */
export const BBOX_TOLERANCE = 1e-9;

/** Side the client clamps to: slightly below the maximum, so rounding to 5 decimals never exceeds it. */
export const CLIENT_BBOX_DEGREES = MAX_BBOX_DEGREES - 1e-4;

/** Cap per layer request; beyond ~5,000 objects the map would need vector tiles (spec 09). A cut layer says so. */
export const MAP_FEATURE_LIMIT = 5000;
