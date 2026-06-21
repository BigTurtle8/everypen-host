// The "scene spec" Claude returns — the creative direction for the experience.
// The shader realizes any spec procedurally; Claude only picks the values.

export type SceneSpec = {
  reading: string;
  motion: {
    archetype: "breathe" | "wave" | "swirl" | "flock";
    speed: number; // ~0.2 .. 1.5
    warp: number; // 0 .. 1
    direction: number; // degrees (wave)
  };
  composition: {
    symmetry: "plain" | "mirror" | "kaleidoscope" | "radial";
    focal: [number, number]; // uv 0..1
    densityGradient: "even" | "center" | "edges";
  };
  palettes: string[][]; // each palette: array of hex colors
};

export const ARCHETYPE_INDEX: Record<SceneSpec["motion"]["archetype"], number> =
  { breathe: 0, wave: 1, swirl: 2, flock: 3 };

export const SYMMETRY_INDEX: Record<
  SceneSpec["composition"]["symmetry"],
  number
> = { plain: 0, mirror: 1, kaleidoscope: 2, radial: 3 };

export const DENSITY_INDEX: Record<
  SceneSpec["composition"]["densityGradient"],
  number
> = { even: 0, center: 1, edges: 2 };

// Used when the API key is missing or the call fails, so the demo never breaks.
export const FALLBACK_SCENE: SceneSpec = {
  reading: "procedural default",
  motion: { archetype: "breathe", speed: 0.5, warp: 0.6, direction: 90 },
  composition: { symmetry: "mirror", focal: [0.5, 0.5], densityGradient: "center" },
  palettes: [
    ["#0d1b2a", "#415a77", "#778da9", "#e0e1dd"],
    ["#2b2d42", "#8d99ae", "#ef233c", "#edf2f4"],
    ["#1a3c34", "#3a7d6e", "#e8c468", "#f4e3b2"],
  ],
};

// JSON Schema for Claude's structured output (no numeric range constraints —
// those aren't supported by structured outputs; we clamp client-side).
export const SCENE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reading: { type: "string" },
    motion: {
      type: "object",
      additionalProperties: false,
      properties: {
        archetype: { type: "string", enum: ["breathe", "wave", "swirl", "flock"] },
        speed: { type: "number" },
        warp: { type: "number" },
        direction: { type: "number" },
      },
      required: ["archetype", "speed", "warp", "direction"],
    },
    composition: {
      type: "object",
      additionalProperties: false,
      properties: {
        symmetry: {
          type: "string",
          enum: ["plain", "mirror", "kaleidoscope", "radial"],
        },
        focal: { type: "array", items: { type: "number" } },
        densityGradient: { type: "string", enum: ["even", "center", "edges"] },
      },
      required: ["symmetry", "focal", "densityGradient"],
    },
    palettes: {
      type: "array",
      items: { type: "array", items: { type: "string" } },
    },
  },
  required: ["reading", "motion", "composition", "palettes"],
} as const;
