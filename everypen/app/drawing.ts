export type NormalizedPoint = {
  x: number;
  y: number;
};

export type Stroke = {
  points: NormalizedPoint[];
};

export type DrawingData = {
  canvasWidth: number;
  canvasHeight: number;
  strokes: Stroke[];
};

export const DRAWING_STORAGE_KEY = "everypen:drawing:v1";

export function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

export function normalizePoint(
  x: number,
  y: number,
  width: number,
  height: number,
): NormalizedPoint {
  return {
    x: clamp01(x / width),
    y: clamp01(y / height),
  };
}

export function loadDrawing(): DrawingData | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(DRAWING_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<DrawingData>;

    if (
      !parsed ||
      typeof parsed.canvasWidth !== "number" ||
      typeof parsed.canvasHeight !== "number" ||
      !Array.isArray(parsed.strokes)
    ) {
      return null;
    }

    return parsed as DrawingData;
  } catch {
    return null;
  }
}

export function saveDrawing(data: DrawingData) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(DRAWING_STORAGE_KEY, JSON.stringify(data));
}

export type RenderOptions = {
  flipX?: boolean;
  flipY?: boolean;
  color?: string;
  strokeIndices?: number[];
  // Fill the whole box instead of preserving aspect ratio (removes gaps).
  stretch?: boolean;
};

export function renderDrawingInBox(
  ctx: CanvasRenderingContext2D,
  drawing: DrawingData,
  box: { x: number; y: number; width: number; height: number },
  strokeWidth = 3,
  options: RenderOptions = {},
) {
  if (!drawing.strokes.length) {
    return;
  }

  const {
    flipX = false,
    flipY = false,
    color = "#000000",
    strokeIndices,
    stretch = false,
  } = options;

  const sourceAspect = drawing.canvasWidth / drawing.canvasHeight;
  const targetAspect = box.width / box.height;

  let drawWidth = box.width;
  let drawHeight = box.height;

  if (!stretch) {
    if (targetAspect > sourceAspect) {
      drawWidth = box.height * sourceAspect;
    } else {
      drawHeight = box.width / sourceAspect;
    }
  }

  const drawX = box.x + (box.width - drawWidth) / 2;
  const drawY = box.y + (box.height - drawHeight) / 2;

  ctx.save();
  ctx.translate(drawX, drawY);
  // Mirror in place around the box center so flipped copies stay aligned.
  ctx.translate(flipX ? drawWidth : 0, flipY ? drawHeight : 0);
  ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;

  const strokesToRender =
    strokeIndices && strokeIndices.length > 0
      ? strokeIndices.map((index) => drawing.strokes[index]).filter(Boolean)
      : drawing.strokes;

  for (const stroke of strokesToRender) {
    if (stroke.points.length < 2) {
      continue;
    }

    ctx.beginPath();
    ctx.moveTo(
      stroke.points[0].x * drawWidth,
      stroke.points[0].y * drawHeight,
    );

    for (const point of stroke.points.slice(1)) {
      ctx.lineTo(point.x * drawWidth, point.y * drawHeight);
    }

    ctx.stroke();
  }

  ctx.restore();
}