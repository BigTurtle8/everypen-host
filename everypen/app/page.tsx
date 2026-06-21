"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useCrayon } from "./crayon";
import {
  type DrawingData,
  loadDrawing,
  normalizePoint,
  saveDrawing,
  type Stroke,
} from "./drawing";

export default function Home() {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);

  const drawingRef = useRef(false);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  // Where the crayon currently points (pen may be up). Used to start a stroke.
  const cursorPosRef = useRef<{ x: number; y: number } | null>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Restore any previous drawing so "Draw more" continues where we left off.
    const saved = loadDrawing();
    if (saved && saved.strokes.length && strokesRef.current.length === 0) {
      strokesRef.current = saved.strokes;
    }

    const setupCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      setCanvasSize({ width: rect.width, height: rect.height });

      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, rect.width, rect.height);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#000000";

      for (const stroke of strokesRef.current) {
        if (stroke.points.length < 2) {
          continue;
        }

        ctx.beginPath();
        ctx.moveTo(
          stroke.points[0].x * rect.width,
          stroke.points[0].y * rect.height,
        );

        for (const point of stroke.points.slice(1)) {
          ctx.lineTo(point.x * rect.width, point.y * rect.height);
        }

        ctx.stroke();
      }
    };

    setupCanvas();
    window.addEventListener("resize", setupCanvas);

    return () => {
      window.removeEventListener("resize", setupCanvas);
    };
  }, []);

  // --- Shared drawing core: both mouse and crayon feed these. ---

  const dims = () => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    return {
      width: canvasSize.width || rect?.width || 0,
      height: canvasSize.height || rect?.height || 0,
    };
  };

  const beginStroke = (x: number, y: number) => {
    const { width, height } = dims();
    if (!width || !height) return;

    drawingRef.current = true;
    lastPointRef.current = { x, y };
    currentStrokeRef.current = {
      points: [normalizePoint(x, y, width, height)],
    };

    const ctx = canvasRef.current?.getContext("2d");
    ctx?.beginPath();
    ctx?.moveTo(x, y);
  };

  const extendStroke = (x: number, y: number) => {
    if (!drawingRef.current || !currentStrokeRef.current) return;

    const ctx = canvasRef.current?.getContext("2d");
    const last = lastPointRef.current;
    if (ctx && last) {
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    lastPointRef.current = { x, y };

    const { width, height } = dims();
    currentStrokeRef.current.points.push(normalizePoint(x, y, width, height));
  };

  const endStroke = () => {
    if (
      currentStrokeRef.current &&
      currentStrokeRef.current.points.length > 1
    ) {
      strokesRef.current.push(currentStrokeRef.current);
    }
    currentStrokeRef.current = null;
    lastPointRef.current = null;
    drawingRef.current = false;
  };

  // --- Mouse input ---

  const getPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = getPoint(event);
    if (!point) return;
    canvasRef.current?.setPointerCapture(event.pointerId);
    beginStroke(point.x, point.y);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const point = getPoint(event);
    if (point) extendStroke(point.x, point.y);
  };

  // --- Crayon input (gyro + ultrasonic over WebSocket) ---

  const moveCursorDot = (x: number, y: number) => {
    const dot = cursorRef.current;
    if (dot) dot.style.transform = `translate(${x}px, ${y}px)`;
  };

  const { status, recenter } = useCrayon({
    canvasRef,
    onCursor: (x, y) => {
      cursorPosRef.current = { x, y };
      moveCursorDot(x, y);
      if (drawingRef.current) extendStroke(x, y);
    },
    onPenChange: (down) => {
      const pos = cursorPosRef.current;
      if (down) {
        if (pos) beginStroke(pos.x, pos.y);
      } else {
        endStroke();
      }
    },
  });

  // --- Navigation ---

  const handleGenerate = () => {
    if (drawingRef.current) endStroke();

    if (canvasSize.width > 0 && canvasSize.height > 0) {
      const data: DrawingData = {
        canvasWidth: canvasSize.width,
        canvasHeight: canvasSize.height,
        strokes: strokesRef.current,
      };
      saveDrawing(data);
    }

    router.push("/generate");
  };

  const statusColor =
    status === "connected"
      ? "bg-green-500"
      : status === "connecting"
        ? "bg-yellow-500"
        : "bg-red-500";

  return (
    <main className="flex min-h-screen w-full flex-col items-center bg-white px-4 py-4 sm:px-6">
      <section className="relative flex w-full max-w-5xl flex-1 flex-col items-center">
        <canvas
          ref={canvasRef}
          className="h-[82vh] w-full rounded-md border border-black bg-white touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endStroke}
          onPointerLeave={endStroke}
        />

        {/* Crayon pointer indicator (only meaningful while connected). */}
        <div
          ref={cursorRef}
          className="pointer-events-none absolute left-0 top-0 -ml-2 -mt-2 h-4 w-4 rounded-full border-2 border-black/70"
          style={{ transform: "translate(-100px, -100px)" }}
        />

        {/* Crayon connection status. */}
        <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-xs text-black backdrop-blur">
          <span className={`h-2 w-2 rounded-full ${statusColor}`} />
          crayon: {status}
        </div>
      </section>

      <div className="mt-5 flex gap-3">
        <button
          type="button"
          onClick={recenter}
          className="rounded border border-black bg-white px-6 py-2 text-sm font-medium text-black transition-colors hover:bg-black hover:text-white"
        >
          Recenter crayon
        </button>
        <button
          type="button"
          onClick={handleGenerate}
          className="rounded border border-black bg-white px-6 py-2 text-sm font-medium text-black transition-colors hover:bg-black hover:text-white"
        >
          Generate
        </button>
      </div>
    </main>
  );
}
