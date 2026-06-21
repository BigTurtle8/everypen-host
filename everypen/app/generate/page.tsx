"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { loadDrawing, renderDrawingInBox } from "../drawing";

export default function GeneratePage() {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const drawing = loadDrawing();
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const render = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;

      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);

      if (!drawing || !drawing.strokes.length) {
        return;
      }

      // Each "cell" is a 2x2 mirrored block (pmm wallpaper symmetry). Mirroring
      // makes the motif's edges meet their neighbours, and stretch-fill leaves no
      // gaps, so the field reads as one continuous pattern with no visible rows.
      const cell = 220;
      const half = cell / 2;
      const columns = Math.ceil(width / cell) + 2;
      const rows = Math.ceil(height / cell) + 2;
      const offsetX = -cell;
      const offsetY = -cell;

      const quads = [
        { dx: 0, dy: 0, flipX: false, flipY: false },
        { dx: half, dy: 0, flipX: true, flipY: false },
        { dx: 0, dy: half, flipX: false, flipY: true },
        { dx: half, dy: half, flipX: true, flipY: true },
      ];

      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const cellX = offsetX + column * cell;
          const cellY = offsetY + row * cell;

          for (const quad of quads) {
            renderDrawingInBox(
              ctx,
              drawing,
              {
                x: cellX + quad.dx,
                y: cellY + quad.dy,
                width: half,
                height: half,
              },
              2,
              { flipX: quad.flipX, flipY: quad.flipY, stretch: true },
            );
          }
        }
      }
    };

    render();
    window.addEventListener("resize", render);

    return () => {
      window.removeEventListener("resize", render);
    };
  }, []);

  return (
    <main className="relative min-h-screen overflow-hidden bg-white">
      <canvas ref={canvasRef} className="fixed inset-0 block" />

      <div className="fixed inset-x-0 bottom-6 z-10 flex justify-center gap-3">
        <button
          type="button"
          onClick={() => router.push("/")}
          className="rounded-full border border-black bg-white/80 px-5 py-2 text-sm font-medium text-black backdrop-blur transition-colors hover:bg-black hover:text-white"
        >
          ← Draw more
        </button>
        <button
          type="button"
          onClick={() => router.push("/experience")}
          className="rounded-full border border-black bg-black px-5 py-2 text-sm font-medium text-white backdrop-blur transition-colors hover:bg-white hover:text-black"
        >
          Create interactive experience →
        </button>
      </div>
    </main>
  );
}
