// Physical constants, SI units (m, s, kg) unless noted. Sources: IERS/WGS-84 for
// Earth, JPL DE for lunar GM, US Standard Atmosphere 1976.

/** Standard gravity, m/s^2 (defines Isp <-> exhaust velocity). */
export const G0 = 9.80665;

/** Earth gravitational parameter GM, m^3/s^2 (WGS-84 / EGM96). */
export const MU_EARTH = 3.986004418e14;
/** Earth equatorial radius, m (WGS-84). */
export const R_EARTH = 6_378_137;
/** Earth sidereal rotation rate, rad/s. */
export const EARTH_ROTATION_RATE = 7.2921159e-5;
/** Earth sphere-of-influence radius with respect to the Sun, m (~0.929e9). */
export const EARTH_SOI = 9.24e8;

/** Moon gravitational parameter GM, m^3/s^2 (JPL DE430: 4902.800066 km^3/s^2). */
export const MU_MOON = 4.902800066e12;
/** Moon mean radius, m. */
export const R_MOON = 1_737_400;
/** Mean Earth-Moon distance, m. The game models the lunar orbit as circular at this radius. */
export const MOON_ORBIT_RADIUS = 384_400e3;
/**
 * Moon mean motion, rad/s, for a circular two-body orbit about Earth using
 * mu_E + mu_M (gives a 27.29 day period, vs. the true 27.32 day sidereal month).
 */
export const MOON_MEAN_MOTION = Math.sqrt((MU_EARTH + MU_MOON) / MOON_ORBIT_RADIUS ** 3);
/** Moon sphere of influence (Laplace): a * (m/M)^(2/5), m. ~66,100 km. */
export const MOON_SOI = MOON_ORBIT_RADIUS * Math.pow(MU_MOON / MU_EARTH, 2 / 5);

/** Sea-level standard pressure, Pa. */
export const P0 = 101_325;
/** Sea-level standard density, kg/m^3. */
export const RHO0 = 1.225;
/** Specific gas constant for dry air (US76: R* / M0), J/(kg K). */
export const R_AIR = 287.05287;
/** Ratio of specific heats for air. */
export const GAMMA_AIR = 1.4;
/** Altitude above which drag is ignored and orbits are treated as pure conics, m. */
export const ATMOSPHERE_TOP = 140_000;
/** Conventional edge of space (Karman line), m. */
export const KARMAN_LINE = 100_000;
/** Conventional entry interface altitude used for reentry targeting, m. */
export const ENTRY_INTERFACE = 121_920; // 400,000 ft

/** Sutton-Graves constant for Earth air, kg^0.5 / m (q = k sqrt(rho / Rn) v^3). */
export const SUTTON_GRAVES_K = 1.7415e-4;

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const DAY = 86_400;
export const HOUR = 3_600;
