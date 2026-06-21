# EveryPen — Host UI

Software side of EveryPen: a digital "crayon" that draws on any surface and
mirrors the strokes on screen in real time. The crayon is built separately; this
app is the screen it draws to. There are three screens:

1. **Draw** (`/`) — draw with a mouse or the crayon.
2. **Generate** (`/generate`) — turns the drawing into a seamless infinite
   pattern (mirrored tessellation).
3. **Experience** (`/experience`) — interactive, AI-distorted display. *Not built
   yet.*

## Input: mouse + crayon

Both inputs feed the same draw core (`beginStroke` / `extendStroke` /
`endStroke` in `app/page.tsx`), so they behave identically. Mouse input works
out of the box for debugging. The crayon connects over WebSocket.

### Crayon data contract

The crayon (or a bridge for it) acts as a **WebSocket server**. The app connects
as a client and expects one JSON string per sensor reading:

```json
{ "gx": 0.0, "gy": 0.0, "gz": 0.0, "ax": 0.0, "ay": 0.0, "az": 0.0, "dist": 0.0 }
```

| Field        | Meaning                          | Units |
| ------------ | -------------------------------- | ----- |
| `gx,gy,gz`   | Gyro / angular velocity          | deg/s |
| `ax,ay,az`   | Accelerometer                    | g     |
| `dist`       | Ultrasonic distance to surface   | cm    |

Default URL: `ws://localhost:8080`. Override per-session without editing code:

```
http://localhost:3000/?ws=ws://192.168.1.50:8080
```

### How motion becomes a cursor (`app/crayon.ts`)

- **Centering:** the **first packet** is taken as the centered reference — the
  cursor is placed at the canvas center and orientation is zeroed. (Send the
  first packet only after the crayon is centered.)
- **Movement:** gyro angular velocity is integrated over time into a yaw/pitch
  angle relative to center. `yaw` → horizontal, `pitch` → vertical. We integrate
  the gyro rather than double-integrating accel because position from accel
  drifts badly.
- **Pen up/down:** `dist <= drawDistanceCm` (and `dist > 0`) means the tip is on
  the surface → pen down → drawing. Otherwise pen up; the cursor dot still tracks
  where the crayon points.

### Tuning (`DEFAULT_CRAYON_CONFIG` in `app/crayon.ts`)

| Setting                  | Default          | What it does                                  |
| ------------------------ | ---------------- | --------------------------------------------- |
| `url`                    | `ws://localhost:8080` | WebSocket to connect to                  |
| `drawDistanceCm`         | `5`              | Pen-down threshold                            |
| `pxPerDeg`               | `12`             | Cursor pixels per degree (sensitivity)        |
| `yawAxis` / `pitchAxis`  | `gz` / `gx`      | Which gyro axis drives each screen axis        |
| `yawSign` / `pitchSign`  | `1` / `1`        | Flip to `-1` to invert that direction          |

You'll likely adjust the axis/sign settings once holding the real crayon: if
left/right is reversed set `yawSign = -1`; if axes feel swapped, swap `gz`/`gx`.

### Drift & the Recenter button

Pure gyro integration drifts over tens of seconds (yaw especially — the
accelerometer can't correct heading). The **Recenter crayon** button re-zeroes
on the next packet. A future improvement is a complementary filter using
`ax/ay/az` to correct pitch.

### Connection status

A pill on the draw screen shows `connecting` (yellow) / `connected` (green) /
`disconnected` (red). The client auto-reconnects every second if the socket
drops.

## Files

| File                   | Role                                                        |
| ---------------------- | ----------------------------------------------------------- |
| `app/page.tsx`         | Draw screen; mouse + crayon input, shared stroke core        |
| `app/crayon.ts`        | `useCrayon` hook: WebSocket + gyro→cursor + ultrasonic→pen   |
| `app/generate/page.tsx`| Infinite mirrored-pattern screen                             |
| `app/drawing.ts`       | Stroke types, localStorage persistence, canvas render helper |

Strokes persist in `localStorage`, so navigating between Draw and Generate keeps
the drawing intact.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
