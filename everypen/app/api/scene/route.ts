import Anthropic from "@anthropic-ai/sdk";
import { SCENE_SCHEMA, type SceneSpec } from "../../scene";

// Claude acts as art director: it looks at the drawing once and returns a scene
// spec (motion archetype, symmetry, focal point, palettes). The shader renders
// it in real time — Claude never runs per frame. Haiku 4.5 is fast (matters at
// load) and supports vision + structured outputs.
const SYSTEM = `You are the art director for a live, generative art installation.
You are shown a hand drawing. Decide how an infinite, animated pattern made from
it should move and feel. Return ONLY the structured scene spec.

Guidance:
- reading: a short evocative phrase for what the drawing brings to mind.
- motion.archetype: breathe (calm), wave (directional flow), swirl (rotational),
  flock (drifting noise). Pick what suits the drawing's energy.
- motion.speed: 0.2 (slow) to 1.5 (lively). motion.warp: 0 (rigid) to 1 (fluid).
  motion.direction: degrees, only meaningful for wave.
- composition.symmetry: mirror or kaleidoscope read as decorative; radial is
  burst-like; plain is a simple grid. focal: [x,y] in 0..1. densityGradient:
  center concentrates the motif in the middle, edges at the rim, even is uniform.
- palettes: 3 harmonious, NON-rainbow palettes of 4-5 hex colors each, tuned to
  the drawing's mood. Avoid evenly-spaced rainbows; favor a coherent color story.`;

export async function POST(request: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "no_api_key" }, { status: 503 });
  }

  let imageBase64: string;
  try {
    const body = (await request.json()) as { image?: string };
    const dataUrl = body.image ?? "";
    imageBase64 = dataUrl.replace(/^data:image\/png;base64,/, "");
    if (!imageBase64) throw new Error("missing image");
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const client = new Anthropic({ apiKey });
    const message = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: SYSTEM,
      output_config: {
        format: { type: "json_schema", schema: SCENE_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: imageBase64,
              },
            },
            {
              type: "text",
              text: "Direct the scene for this drawing. Return the scene spec.",
            },
          ],
        },
      ],
    });

    const text = message.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") {
      return Response.json({ error: "no_output" }, { status: 502 });
    }
    const spec = JSON.parse(text.text) as SceneSpec;
    return Response.json(spec);
  } catch (err) {
    console.error("scene route error:", err);
    return Response.json({ error: "claude_failed" }, { status: 502 });
  }
}
