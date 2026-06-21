"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useCrayon } from "../crayon";
import { loadDrawing, renderDrawingInBox } from "../drawing";
import {
  ARCHETYPE_INDEX,
  DENSITY_INDEX,
  FALLBACK_SCENE,
  type SceneSpec,
  SYMMETRY_INDEX,
} from "../scene";

// How many recent cursor samples form the distortion trail, and how many
// colored stamps can be alive at once. Both are fixed-size shader arrays.
const MAX_TOUCH = 16;
const MAX_STAMP = 12;
const MAX_PALETTE = 6;
// How often the "background muse" re-imagines the scene (ms).
const MUSE_INTERVAL_MS = 25000;

// Stamp colors cycled on each crayon tap. Phase E replaces these with Claude's
// palette; kept deliberately non-rainbow / harmonious for now.
const STAMP_PALETTE = [
  "#ff5d73",
  "#ffd166",
  "#06d6a0",
  "#4cc9f0",
  "#b5179e",
  "#f77f00",
  "#80ffdb",
];

// --- Shaders (GLSL ES 3.00 / WebGL2) ---

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Phase C: crayon/mouse drives a decaying displacement trail (local distortion)
// and colored stamps. Color of the base field + Claude direction come in D/E.
const FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 frag;

uniform float uTime;
uniform vec2 uResolution;
uniform sampler2D uMotif;
uniform float uTileScale;

uniform float uSpeed;       // overall motion rate
uniform float uWarp;        // displacement intensity (0..1)
uniform float uDirection;   // degrees, used by 'wave'
uniform int   uArchetype;   // 0 breathe, 1 wave, 2 swirl, 3 flock

// Distortion trail: recent cursor positions (uv space, y-up), with birth time
// and strength (from crayon speed). Empty slots have time far in the past.
uniform vec2  uTouchPos[${MAX_TOUCH}];
uniform float uTouchTime[${MAX_TOUCH}];
uniform float uTouchStr[${MAX_TOUCH}];

// Colored stamps dropped on taps.
uniform vec2  uStampPos[${MAX_STAMP}];
uniform float uStampTime[${MAX_STAMP}];
uniform vec3  uStampColor[${MAX_STAMP}];

// Composition (Phase D). Driven by Claude's scene spec in Phase E.
uniform int   uSymmetry;   // 0 plain, 1 mirror, 2 kaleidoscope, 3 radial
uniform vec2  uFocal;      // focal point in uv (0..1)
uniform int   uDensity;    // 0 even, 1 dense center, 2 dense edges

// Active palette (Phase E). Claude's colors, smoothly crossfaded on the CPU.
uniform vec3  uPalette[${MAX_PALETTE}];
uniform int   uPaletteCount;

// --- Value noise / fbm for organic flow ---
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}

// Displacement in screen-space units (p ~ [0..aspect] x [0..1]).
vec2 motionWarp(vec2 p, vec2 center, float t) {
  if (uArchetype == 1) {
    // wave: sinusoidal ridges travelling along uDirection
    float a = radians(uDirection);
    vec2 dir = vec2(cos(a), sin(a));
    vec2 perp = vec2(-dir.y, dir.x);
    float phase = dot(p, dir) * 6.0 - t * 2.5;
    return perp * sin(phase) * 0.06 * uWarp + dir * 0.03 * uWarp * sin(t * 0.5);
  } else if (uArchetype == 2) {
    // swirl: rotate around center, stronger near the middle
    vec2 c = p - center;
    float r = length(c);
    float ang = uWarp * 1.0 * sin(t * 0.4) / (r + 0.25);
    float s = sin(ang), co = cos(ang);
    vec2 rc = vec2(c.x * co - c.y * s, c.x * s + c.y * co);
    return rc - c;
  } else if (uArchetype == 3) {
    // flock: curl-like noise advection, everything drifts together
    vec2 d = vec2(
      fbm(p * 2.0 + vec2(0.0, t * 0.45)),
      fbm(p * 2.0 + vec2(7.3, -t * 0.42))
    ) - 0.5;
    return d * 0.10 * uWarp;
  }
  // breathe (default): gentle global drift + low-frequency wobble
  vec2 d = vec2(
    fbm(p * 1.2 + t * 0.24),
    fbm(p * 1.2 - t * 0.28)
  ) - 0.5;
  return d * 0.08 * uWarp + 0.05 * uWarp * vec2(sin(t * 0.85), cos(t * 0.70));
}

// Local lens distortion from the crayon trail: each sample pushes the pattern
// outward, falling off with distance (Gaussian) and age (exponential). Gentle
// and slow-decaying so the warp is readable rather than a violent snap.
vec2 touchWarp(vec2 p, vec2 aspect) {
  vec2 disp = vec2(0.0);
  const float SIGMA2 = 0.02;  // spatial radius^2 (broader = gentler)
  for (int i = 0; i < ${MAX_TOUCH}; i++) {
    float age = uTime - uTouchTime[i];
    if (age < 0.0 || age > 3.5) continue;
    vec2 d = p - uTouchPos[i] * aspect;
    float r2 = dot(d, d);
    float space = exp(-r2 / (2.0 * SIGMA2));
    float decay = exp(-age * 1.0);
    disp += normalize(d + 1e-4) * uTouchStr[i] * space * decay * 0.06;
  }
  return disp;
}

// Sample the active palette as a smooth ring, so a scalar in [0,1) maps to a
// blended color and the wander never sees a hard seam.
vec3 paletteAt(float t) {
  float n = float(max(uPaletteCount, 1));
  float f = fract(t) * n;
  int i = int(f);
  int j = i + 1;
  if (j >= uPaletteCount) j = 0;
  return mix(uPalette[i], uPalette[j], smoothstep(0.0, 1.0, fract(f)));
}

// The design's own color: different regions sit at different points in the
// palette (a moving spatial field + a positional gradient), and the whole thing
// drifts over time — so the field shows several colors at once and never settles
// into a single predictable hue.
vec3 designColor(vec2 q, float t) {
  float flow = fbm(q * 1.3 + vec2(t * 0.15, -t * 0.12)); // moving color field
  float drift = fbm(vec2(t * 0.22, 4.0));                // global wander
  float phase = t * 0.05 + drift + flow * 1.4 + q.x * 0.4;
  return paletteAt(phase);
}

// Small bright bursts that pop along the trail and flash out quickly, with
// per-sample random size/color so the motion feels unpredictable and alive.
vec3 touchBurst(vec2 p, vec2 aspect) {
  vec3 c = vec3(0.0);
  for (int i = 0; i < ${MAX_TOUCH}; i++) {
    float age = uTime - uTouchTime[i];
    if (age < 0.0 || age > 1.5) continue;
    vec2 d = p - uTouchPos[i] * aspect;
    float r = length(d);
    float seed = hash(vec2(float(i), floor(uTouchTime[i] * 7.0) + 0.5));
    float size = mix(0.008, 0.028, seed);
    float dot = smoothstep(size, 0.0, r);
    float flash = exp(-age * 6.0) * uTouchStr[i];
    c += paletteAt(seed) * dot * flash;
  }
  return c;
}

// --- Composition: map a warped screen position to a motif sample coord ---
vec2 tileCoord(vec2 wp, vec2 focalP) {
  if (uSymmetry == 2) {
    // kaleidoscope: fold angle around focal into mirrored wedges
    vec2 q = wp - focalP;
    float ang = atan(q.y, q.x);
    float rad = length(q);
    float seg = 6.2831 / 6.0;
    ang = mod(ang, seg);
    ang = abs(ang - seg * 0.5);
    return (vec2(cos(ang), sin(ang)) * rad + focalP) * uTileScale;
  } else if (uSymmetry == 3) {
    // radial: concentric rings repeating around focal
    vec2 q = wp - focalP;
    float ang = atan(q.y, q.x);
    return vec2(ang / 6.2831 * 4.0, length(q) * uTileScale);
  }
  // plain / mirror both start from a square grid
  return wp * uTileScale;
}

float densityFactor(float dist) {
  if (uDensity == 1) return mix(1.0, 0.35, smoothstep(0.1, 0.9, dist));
  if (uDensity == 2) return mix(0.35, 1.0, smoothstep(0.0, 0.8, dist));
  return 1.0;
}

void main() {
  // Keep tiles square regardless of screen aspect.
  vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
  vec2 p = vUv * aspect;
  vec2 center = 0.5 * aspect;
  float t = uTime * uSpeed;

  vec2 focalP = uFocal * aspect;
  vec2 wp = p + motionWarp(p, center, t) + touchWarp(p, aspect);

  // Composition: symmetry mapping, then mirror-fold for the 'mirror' mode.
  vec2 uv = tileCoord(wp, focalP);
  vec2 suv = (uSymmetry == 1) ? abs(fract(uv * 0.5) - 0.5) * 2.0 : fract(uv);

  // The motif texture stores the drawing in its alpha channel (ink = opaque).
  float ink = texture(uMotif, suv).a;
  ink *= densityFactor(length(p - focalP));

  // Accumulate stamp color: each bloom grows and fades with age.
  vec3 stampTint = vec3(0.0);
  float stampW = 0.0;
  for (int i = 0; i < ${MAX_STAMP}; i++) {
    float age = uTime - uStampTime[i];
    if (age < 0.0 || age > 5.0) continue;
    vec2 d = p - uStampPos[i] * aspect;
    float r = length(d);
    float radius = 0.05 + age * 0.05;
    float bloom = smoothstep(radius, 0.0, r) * exp(-age * 0.5);
    stampTint += uStampColor[i] * bloom;
    stampW += bloom;
  }

  vec3 bg = vec3(0.04, 0.04, 0.06);
  vec3 base = designColor(wp, uTime); // the design's own evolving color

  vec3 inkColor = base;
  if (stampW > 0.001) {
    inkColor = mix(base, stampTint / stampW, clamp(stampW, 0.0, 1.0));
  }
  vec3 col = mix(bg, inkColor, ink);

  col += stampTint * 0.06;            // soft colored haze around stamps
  col += touchBurst(p, aspect) * 0.9; // little colored pops along the trail

  frag = vec4(col, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext) {
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Render the user's strokes into a square offscreen canvas. Strokes are opaque
// over a transparent background, so the shader reads the shape from alpha and is
// free to colorize it later. Stretch-fill keeps tiles seamless.
function buildMotifCanvas(size = 512): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const drawing = loadDrawing();
  if (drawing && drawing.strokes.length) {
    renderDrawingInBox(
      ctx,
      drawing,
      { x: 0, y: 0, width: size, height: size },
      size * 0.012,
      { stretch: true, color: "#000000" },
    );
  }
  return canvas;
}

export default function ExperiencePage() {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorDotRef = useRef<HTMLDivElement>(null);

  // Current shader clock (seconds since start), read by interaction handlers.
  const timeRef = useRef(0);

  // Distortion trail ring buffer + colored stamp ring buffer.
  const touch = useRef({
    pos: new Float32Array(MAX_TOUCH * 2),
    time: new Float32Array(MAX_TOUCH).fill(-1000),
    str: new Float32Array(MAX_TOUCH),
    head: 0,
  });
  const stamps = useRef({
    pos: new Float32Array(MAX_STAMP * 2),
    time: new Float32Array(MAX_STAMP).fill(-1000),
    color: new Float32Array(MAX_STAMP * 3),
    head: 0,
    paletteIndex: 0,
  });

  // Last cursor in uv space, for velocity + stamp placement.
  const cursorUv = useRef<{ x: number; y: number } | null>(null);

  // --- Scene state (Phase E) ---
  // Continuous params are eased toward `targ` each frame (the crossfade);
  // discrete params snap. Palette colors ease channel-by-channel toward `palTar`.
  const live = useRef({ speed: 0.5, warp: 0.6, direction: 90, focalX: 0.5, focalY: 0.5 });
  const targ = useRef({ speed: 0.5, warp: 0.6, direction: 90, focalX: 0.5, focalY: 0.5 });
  const disc = useRef({ archetype: 0, symmetry: 1, density: 1 });
  const palCur = useRef(new Float32Array(MAX_PALETTE * 3));
  const palTar = useRef(new Float32Array(MAX_PALETTE * 3));
  const palCount = useRef(1);
  // Palette colors as [r,g,b] for stamps to pull from (matches the field).
  const paletteColors = useRef<[number, number, number][]>([]);
  // Advances each scene so consecutive muse refreshes pick a different palette.
  const paletteCycle = useRef(0);
  // What Claude "saw" — shown in the UI so we can confirm it responded.
  const [reading, setReading] = useState("procedural");

  const applyScene = (spec: SceneSpec) => {
    const clamp = (v: number, lo: number, hi: number) =>
      Math.min(hi, Math.max(lo, v));
    targ.current = {
      speed: clamp(spec.motion.speed, 0.1, 2),
      warp: clamp(spec.motion.warp, 0, 1),
      direction: spec.motion.direction,
      focalX: clamp(spec.composition.focal[0] ?? 0.5, 0, 1),
      focalY: clamp(spec.composition.focal[1] ?? 0.5, 0, 1),
    };
    disc.current = {
      archetype: ARCHETYPE_INDEX[spec.motion.archetype] ?? 0,
      symmetry: SYMMETRY_INDEX[spec.composition.symmetry] ?? 1,
      density: DENSITY_INDEX[spec.composition.densityGradient] ?? 1,
    };
    setReading(spec.reading);
    // Rotate through the returned palettes so each refresh looks different.
    const palettes = spec.palettes.length ? spec.palettes : [[]];
    const chosen = palettes[paletteCycle.current % palettes.length];
    paletteCycle.current += 1;
    const colors = (chosen ?? []).slice(0, MAX_PALETTE);
    const rgb = colors.map(hexToRgb);
    if (rgb.length) {
      paletteColors.current = rgb;
      palCount.current = rgb.length;
      rgb.forEach(([r, g, b], i) => {
        palTar.current[i * 3] = r;
        palTar.current[i * 3 + 1] = g;
        palTar.current[i * 3 + 2] = b;
      });
    }
  };

  // Feed a cursor position (CSS pixels) -> records a distortion sample.
  const feedCursor = (xCss: number, yCss: number) => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const ux = xCss / w;
    const uy = 1 - yCss / h; // flip to shader's y-up uv space

    const last = cursorUv.current;
    const speed = last
      ? Math.hypot(ux - last.x, uy - last.y)
      : 0;
    cursorUv.current = { x: ux, y: uy };

    const strength = Math.min(1.2, Math.max(0.2, speed * 8));
    const t = touch.current;
    t.pos[t.head * 2] = ux;
    t.pos[t.head * 2 + 1] = uy;
    t.time[t.head] = timeRef.current;
    t.str[t.head] = strength;
    t.head = (t.head + 1) % MAX_TOUCH;

    const dot = cursorDotRef.current;
    if (dot) dot.style.transform = `translate(${xCss}px, ${yCss}px)`;
  };

  // Drop a colored stamp at the current cursor.
  const dropStamp = () => {
    const pos = cursorUv.current;
    if (!pos) return;
    const s = stamps.current;
    // Pull from the active (Claude) palette so stamps match the field; fall back
    // to the built-in palette before a scene has loaded.
    const pal = paletteColors.current;
    const [r, g, b] =
      pal.length > 0
        ? pal[s.paletteIndex % pal.length]
        : hexToRgb(STAMP_PALETTE[s.paletteIndex % STAMP_PALETTE.length]);
    s.paletteIndex += 1;
    s.pos[s.head * 2] = pos.x;
    s.pos[s.head * 2 + 1] = pos.y;
    s.time[s.head] = timeRef.current;
    s.color[s.head * 3] = r;
    s.color[s.head * 3 + 1] = g;
    s.color[s.head * 3 + 2] = b;
    s.head = (s.head + 1) % MAX_STAMP;
  };

  // --- Crayon (gyro cursor + ultrasonic tap) ---
  const { status, recenter } = useCrayon({
    canvasRef,
    onCursor: (x, y) => feedCursor(x, y),
    onPenChange: (down) => {
      if (down) dropStamp();
    },
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext("webgl2", { antialias: true });
    if (!gl) {
      console.error("WebGL2 not available");
      return;
    }

    const program = createProgram(gl);
    gl.useProgram(program);

    // Fullscreen triangle (covers the clip-space viewport with one primitive).
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // Upload the motif as a texture.
    const motif = buildMotifCanvas();
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, motif);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const u = (name: string) => gl.getUniformLocation(program, name);
    const uTime = u("uTime");
    const uResolution = u("uResolution");
    const uTileScale = u("uTileScale");
    const uSpeed = u("uSpeed");
    const uWarp = u("uWarp");
    const uDirection = u("uDirection");
    const uArchetype = u("uArchetype");
    const uTouchPos = u("uTouchPos");
    const uTouchTime = u("uTouchTime");
    const uTouchStr = u("uTouchStr");
    const uStampPos = u("uStampPos");
    const uStampTime = u("uStampTime");
    const uStampColor = u("uStampColor");
    gl.uniform1i(u("uMotif"), 0);
    gl.uniform1f(uTileScale, 4.0);

    const uSymmetry = u("uSymmetry");
    const uFocal = u("uFocal");
    const uDensity = u("uDensity");
    const uPalette = u("uPalette");
    const uPaletteCount = u("uPaletteCount");

    // Seed the procedural fallback scene so the field is colored immediately,
    // before (or instead of) Claude's spec. Copy target palette into the live
    // one so there's no fade-in from black.
    applyScene(FALLBACK_SCENE);
    live.current = { ...targ.current };
    palCur.current.set(palTar.current);

    // Testing aids: 1-4 switch motion archetype, 5-8 switch symmetry.
    const onKey = (e: KeyboardEvent) => {
      const arche: Record<string, number> = { "1": 0, "2": 1, "3": 2, "4": 3 };
      const sym: Record<string, number> = { "5": 0, "6": 1, "7": 2, "8": 3 };
      if (e.key in arche) disc.current.archetype = arche[e.key];
      if (e.key in sym) disc.current.symmetry = sym[e.key];
    };
    window.addEventListener("keydown", onKey);

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.floor(window.innerWidth * dpr);
      const h = Math.floor(window.innerHeight * dpr);
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uResolution, w, h);
    };
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    const start = performance.now();
    const EASE = 0.04; // crossfade rate toward the latest scene spec
    const loop = () => {
      const time = (performance.now() - start) / 1000;
      timeRef.current = time;
      gl.uniform1f(uTime, time);

      // Ease continuous scene params toward their targets (the crossfade).
      const l = live.current;
      const tg = targ.current;
      l.speed += (tg.speed - l.speed) * EASE;
      l.warp += (tg.warp - l.warp) * EASE;
      l.direction += (tg.direction - l.direction) * EASE;
      l.focalX += (tg.focalX - l.focalX) * EASE;
      l.focalY += (tg.focalY - l.focalY) * EASE;
      gl.uniform1f(uSpeed, l.speed);
      gl.uniform1f(uWarp, l.warp);
      gl.uniform1f(uDirection, l.direction);
      gl.uniform2f(uFocal, l.focalX, l.focalY);
      gl.uniform1i(uArchetype, disc.current.archetype);
      gl.uniform1i(uSymmetry, disc.current.symmetry);
      gl.uniform1i(uDensity, disc.current.density);

      // Ease palette colors toward the target palette, then upload.
      const pc = palCur.current;
      const pt = palTar.current;
      for (let i = 0; i < pc.length; i += 1) pc[i] += (pt[i] - pc[i]) * EASE;
      gl.uniform3fv(uPalette, pc);
      gl.uniform1i(uPaletteCount, palCount.current);

      // Push interaction buffers to the GPU.
      gl.uniform2fv(uTouchPos, touch.current.pos);
      gl.uniform1fv(uTouchTime, touch.current.time);
      gl.uniform1fv(uTouchStr, touch.current.str);
      gl.uniform2fv(uStampPos, stamps.current.pos);
      gl.uniform1fv(uStampTime, stamps.current.time);
      gl.uniform3fv(uStampColor, stamps.current.color);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      raf = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKey);
      gl.deleteProgram(program);
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
    };
  }, []);

  // --- Background muse: Claude re-imagines the scene periodically ---
  useEffect(() => {
    let cancelled = false;

    const fetchScene = async () => {
      try {
        const image = buildMotifCanvas().toDataURL("image/png");
        const res = await fetch("/api/scene", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image }),
        });
        if (!res.ok) {
          console.warn("scene fetch failed:", res.status, await res.text());
          return; // keep the current (procedural) scene
        }
        const spec = (await res.json()) as SceneSpec;
        console.log("scene:", spec.reading, spec.motion, spec.composition);
        if (!cancelled) applyScene(spec);
      } catch (err) {
        console.warn("scene fetch error:", err);
      }
    };

    fetchScene();
    const timer = setInterval(fetchScene, MUSE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Mouse input for debugging (mirrors the crayon) ---
  const onPointerMove = (e: React.PointerEvent) => feedCursor(e.clientX, e.clientY);
  const onPointerDown = (e: React.PointerEvent) => {
    feedCursor(e.clientX, e.clientY);
    dropStamp();
  };

  const statusColor =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";

  return (
    <main className="relative min-h-screen overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        className="fixed inset-0 block touch-none"
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
      />

      {/* Crayon pointer indicator. */}
      <div
        ref={cursorDotRef}
        className="pointer-events-none fixed left-0 top-0 -ml-2 -mt-2 h-4 w-4 rounded-full border-2 border-white/70 mix-blend-difference"
        style={{ transform: "translate(-100px, -100px)" }}
      />

      <div className="fixed left-3 top-3 z-10 flex flex-col gap-1 text-xs text-white">
        <div className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 backdrop-blur">
          <span className={`h-2 w-2 rounded-full ${statusColor}`} />
          crayon: {status}
        </div>
        <div className="rounded-full bg-white/10 px-3 py-1 italic backdrop-blur">
          {reading}
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-6 z-10 flex justify-center gap-3">
        <button
          type="button"
          onClick={() => router.push("/generate")}
          className="rounded-full border border-white/40 bg-black/40 px-5 py-2 text-sm font-medium text-white backdrop-blur transition-colors hover:bg-white hover:text-black"
        >
          ← Back to pattern
        </button>
        <button
          type="button"
          onClick={recenter}
          className="rounded-full border border-white/40 bg-black/40 px-5 py-2 text-sm font-medium text-white backdrop-blur transition-colors hover:bg-white hover:text-black"
        >
          Recenter crayon
        </button>
      </div>
    </main>
  );
}
