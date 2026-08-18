/**
 * Courage Wall — Cloudflare Worker backend
 *
 * Endpoints:
 *   POST   /api/vote   body: { commitment: string }              -> record a vote
 *   GET    /api/votes                                            -> { votes: [...] }
 *   DELETE /api/votes  body: { pin: string }                     -> clear votes (401 if wrong pin)
 *
 * Storage: a single Cloudflare KV key holding a JSON array of vote objects.
 * Set ADMIN_PIN via `wrangler.toml` [vars] or a secret; falls back to "1234".
 */

const KV_KEY = "votes";

const COMMITMENTS = [
  "Learn more",
  "Attend training",
  "Challenge assumptions",
  "Speak up",
  "Support colleague",
  "Share story",
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function getVotes(env) {
  const raw = await env.VOTES_KV.get(KV_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function saveVotes(env, votes) {
  await env.VOTES_KV.put(KV_KEY, JSON.stringify(votes));
}

async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const pin = env.ADMIN_PIN || "1234";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === "/api/vote" && request.method === "POST") {
      const body = await parseJsonBody(request);
      const commitment = body?.commitment;

      if (typeof commitment !== "string" || !COMMITMENTS.includes(commitment)) {
        return jsonResponse({ error: "Invalid commitment" }, 400);
      }

      const votes = await getVotes(env);
      votes.push({ commitment, timestamp: Date.now() });
      await saveVotes(env, votes);

      return jsonResponse({ success: true, count: votes.length });
    }

    if (url.pathname === "/api/votes" && request.method === "GET") {
      const votes = await getVotes(env);
      return jsonResponse({ votes });
    }

    if (url.pathname === "/api/votes" && request.method === "DELETE") {
      const body = await parseJsonBody(request);

      if (body?.pin !== pin) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }

      await saveVotes(env, []);
      return jsonResponse({ success: true });
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
