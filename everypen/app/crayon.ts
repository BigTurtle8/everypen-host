"use client";

import { useEffect, useRef, useState } from "react";

// One reading from the crayon. Units: gyro in deg/s, accel in g, dist in cm.
export type SensorPacket = {
  gx: number;
  gy: number;
  gz: number;
  ax: number;
  ay: number;
  az: number;
  dist: number;
};

export type CrayonConfig = {
  // WebSocket the crayon (or its bridge) serves JSON packets on.
  url: string;
  // Pen is "down" (drawing) when the ultrasonic distance is at/below this.
  drawDistanceCm: number;
  // Cursor pixels moved per degree of crayon rotation. Higher = more sensitive.
  pxPerDeg: number;
  // Which gyro axis drives each screen axis, and its sign. Tweak to match how
  // the crayon is physically held (e.g. set yawSign = -1 to invert left/right).
  yawAxis: "gx" | "gy" | "gz";
  pitchAxis: "gx" | "gy" | "gz";
  yawSign: number;
  pitchSign: number;
};

export const DEFAULT_CRAYON_CONFIG: CrayonConfig = {
  url: "ws://localhost:8080",
  drawDistanceCm: 5,
  pxPerDeg: 12,
  // Crayon pointed at the screen: twisting (gz) sweeps left/right, tilting the
  // tip up/down (gx) sweeps up/down. Swap/negate these if movement feels off.
  yawAxis: "gz",
  pitchAxis: "gx",
  yawSign: 1,
  pitchSign: 1,
};

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

type Callbacks = {
  // Where the crayon currently points, in canvas CSS pixels.
  onCursor: (x: number, y: number) => void;
  // Pen contact changed (true = touching surface = drawing).
  onPenChange: (down: boolean) => void;
  // Element whose size/center the cursor maps into.
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parsePacket(raw: string): SensorPacket | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const keys: (keyof SensorPacket)[] = [
      "gx",
      "gy",
      "gz",
      "ax",
      "ay",
      "az",
      "dist",
    ];
    const packet = {} as SensorPacket;
    for (const key of keys) {
      if (!isFiniteNumber(data[key])) return null;
      packet[key] = data[key] as number;
    }
    return packet;
  } catch {
    return null;
  }
}

/**
 * Connects to the crayon over WebSocket and converts gyro + ultrasonic readings
 * into a screen cursor and pen-down state. The first packet defines "centered"
 * (cursor at canvas center); subsequent rotation moves the cursor from there.
 */
export function useCrayon(
  callbacks: Callbacks,
  config: Partial<CrayonConfig> = {},
) {
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  // Keep latest callbacks/config in refs so the socket effect runs once.
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;
  const cfgRef = useRef<CrayonConfig>({ ...DEFAULT_CRAYON_CONFIG, ...config });
  cfgRef.current = { ...DEFAULT_CRAYON_CONFIG, ...config };

  // Integration state.
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const centeredRef = useRef(false);
  const lastTsRef = useRef(0);
  const penDownRef = useRef(false);

  // Lets the UI ask for a fresh center (re-zeroes on the next packet).
  const recenter = useRef(() => {
    centeredRef.current = false;
  });

  useEffect(() => {
    // Allow overriding the socket URL with ?ws=... for quick hackathon testing.
    const params = new URLSearchParams(window.location.search);
    const url = params.get("ws") || cfgRef.current.url;

    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const handlePacket = (packet: SensorPacket) => {
      const cfg = cfgRef.current;
      const canvas = cbRef.current.canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();

      const now = performance.now();

      // First packet after centering: zero the orientation, place at center.
      if (!centeredRef.current) {
        centeredRef.current = true;
        yawRef.current = 0;
        pitchRef.current = 0;
        lastTsRef.current = now;
        cbRef.current.onCursor(rect.width / 2, rect.height / 2);
      } else {
        const dt = (now - lastTsRef.current) / 1000;
        lastTsRef.current = now;

        // Integrate angular velocity into an angle relative to center.
        yawRef.current += cfg.yawSign * packet[cfg.yawAxis] * dt;
        pitchRef.current += cfg.pitchSign * packet[cfg.pitchAxis] * dt;

        const x = clamp(
          rect.width / 2 + yawRef.current * cfg.pxPerDeg,
          0,
          rect.width,
        );
        // Screen y grows downward, so subtract pitch (tilt up -> move up).
        const y = clamp(
          rect.height / 2 - pitchRef.current * cfg.pxPerDeg,
          0,
          rect.height,
        );
        cbRef.current.onCursor(x, y);
      }

      // Ultrasonic proximity -> pen contact. Ignore non-positive readings.
      const down = packet.dist > 0 && packet.dist <= cfg.drawDistanceCm;
      if (down !== penDownRef.current) {
        penDownRef.current = down;
        cbRef.current.onPenChange(down);
      }
    };

    const connect = () => {
      setStatus("connecting");
      socket = new WebSocket(url);

      socket.onopen = () => setStatus("connected");
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const packet = parsePacket(event.data);
        if (packet) handlePacket(packet);
      };
      socket.onclose = () => {
        setStatus("disconnected");
        if (!closed) reconnectTimer = setTimeout(connect, 1000);
      };
      socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  return { status, recenter: recenter.current };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
