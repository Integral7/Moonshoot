// Graphics quality presets. Everything visually expensive reads from here.

export type QualityLevel = 'low' | 'medium' | 'high';

export interface QualityPreset {
  level: QualityLevel;
  /** Upper bound on devicePixelRatio. */
  pixelRatioCap: number;
  antialias: boolean;
  /** Segments for planet spheres (width segments; height = half). */
  sphereSegments: number;
  starCount: number;
  /** Lunar landing terrain grid resolution (vertices per side). */
  terrainResolution: number;
  /** Max exhaust particles per engine plume. */
  particleCount: number;
  /** Max points kept in a flight trail. */
  trailPoints: number;
  /** Resolution of procedurally generated planet textures (width; height = half). */
  planetTextureSize: number;
  bloom: boolean;
  clouds: boolean;
  shadows: boolean;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  low: {
    level: 'low',
    pixelRatioCap: 1,
    antialias: false,
    sphereSegments: 48,
    starCount: 2500,
    terrainResolution: 96,
    particleCount: 150,
    trailPoints: 600,
    planetTextureSize: 512,
    bloom: false,
    clouds: false,
    shadows: false,
  },
  medium: {
    level: 'medium',
    pixelRatioCap: 1.5,
    antialias: true,
    sphereSegments: 96,
    starCount: 7000,
    terrainResolution: 160,
    particleCount: 400,
    trailPoints: 1500,
    planetTextureSize: 1024,
    bloom: true,
    clouds: true,
    shadows: false,
  },
  high: {
    level: 'high',
    pixelRatioCap: 2,
    antialias: true,
    sphereSegments: 160,
    starCount: 15000,
    terrainResolution: 256,
    particleCount: 900,
    trailPoints: 4000,
    planetTextureSize: 2048,
    bloom: true,
    clouds: true,
    shadows: true,
  },
};

export function isQualityLevel(v: unknown): v is QualityLevel {
  return v === 'low' || v === 'medium' || v === 'high';
}
