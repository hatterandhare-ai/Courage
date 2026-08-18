/**
 * Courage Wall — Cloudflare Worker backend
 *
 * Storage: a single Cloudflare KV namespace (binding VOTES_KV), holding
 * four JSON values under fixed keys — votes, commitments (the pledge
 * options), settings (campaign branding + goal), and background (an
 * admin-uploaded data: URL for the display screen). There's no database;
 * each value is just read, modified, and written back whole.
 *
 * Endpoints:
 *   GET    /api/state                                   -> { votes, commitments, settings, background }
 *                                                            (combined read, meant for polling)
 *
 *   POST   /api/vote        { commitmentId }             -> add a pledge (public)
 *   GET    /api/votes                                    -> { votes: [...] }
 *   PATCH  /api/vote/:id    { pin, commitmentId }         -> reassign one pledge (admin)
 *   DELETE /api/vote/:id    { pin }                       -> remove one pledge (admin)
 *   DELETE /api/votes       { pin }                       -> clear all pledges (admin)
 *
 *   GET    /api/commitments                              -> { commitments: [...] }
 *   PUT    /api/commitments { pin, commitments }          -> replace the pledge options (admin)
 *
 *   GET    /api/settings                                 -> { settings }
 *   PUT    /api/settings    { pin, settings }             -> update campaign branding / goal (admin)
 *
 *   GET    /api/background                                -> { background }
 *   PUT    /api/background  { pin, dataUrl }               -> set the display background image (admin)
 *   DELETE /api/background  { pin }                        -> clear the display background image (admin)
 *
 * Set ADMIN_PIN via wrangler.toml [vars] or a secret; falls back to "1234".
 */

const KEYS = {
  votes: "votes",
  commitments: "commitments",
  settings: "settings",
  background: "background",
};

const DEFAULT_COMMITMENTS = [
  { id: "learn", label: "Learn more", color: "#7c3aed" },
  { id: "training", label: "Attend training", color: "#3b82f6" },
  { id: "challenge", label: "Challenge assumptions", color: "#10b981" },
  { id: "speak", label: "Speak up", color: "#f59e0b" },
  { id: "support", label: "Support colleague", color: "#f97316" },
  { id: "share", label: "Share story", color: "#ef4444" },
];

const DEFAULT_SETTINGS = {
  eyebrow: "Wear It Purple Day",
  title: "Courage Wall",
  tagline: "Pick one commitment you're making today. It'll land on the wall right away.",
  accentColor: "#4C1D6B",
  goalEnabled: false,
  goalTarget: 100,
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const VOTE_ID = /^[a-zA-Z0-9]+$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function getJSON(env, key, fallback) {
  const raw = await env.VOTES_KV.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

async function putJSON(env, key, value) {
  await env.VOTES_KV.put(key, JSON.stringify(value));
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function parseBody(request) {
  try {
    return await request.json();
  } catch (err) {
    return null;
  }
}

function checkPin(env, body) {
  const pin = env.ADMIN_PIN || "1234";
  return typeof body?.pin === "string" && body.pin === pin;
}

function sanitizeCommitments(list) {
  if (!Array.isArray(list)) return null;
  const clean = list
    .filter((c) => c && typeof c.id === "string" && c.id.length > 0 && typeof c.label === "string" && HEX_COLOR.test(c.color))
    .map((c) => ({ id: c.id.slice(0, 40), label: c.label.trim().slice(0, 60) || "Untitled", color: c.color }));
  return clean.length > 0 ? clean : null;
}

function sanitizeSettings(incoming, current) {
  return {
    eyebrow: typeof incoming?.eyebrow === "string" ? incoming.eyebrow.slice(0, 60) : current.eyebrow,
    title: typeof incoming?.title === "string" && incoming.title.trim() ? incoming.title.slice(0, 60) : current.title,
    tagline: typeof incoming?.tagline === "string" ? incoming.tagline.slice(0, 160) : current.tagline,
    accentColor: HEX_COLOR.test(incoming?.accentColor) ? incoming.accentColor : current.accentColor,
    goalEnabled: typeof incoming?.goalEnabled === "boolean" ? incoming.goalEnabled : current.goalEnabled,
    goalTarget:
      Number.isFinite(incoming?.goalTarget) && incoming.goalTarget > 0
        ? Math.floor(incoming.goalTarget)
        : current.goalTarget,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ---- combined read, used by the display/admin polling loop ----
    if (pathname === "/api/state" && method === "GET") {
      const [votes, commitments, settings, background] = await Promise.all([
        getJSON(env, KEYS.votes, []),
        getJSON(env, KEYS.commitments, DEFAULT_COMMITMENTS),
        getJSON(env, KEYS.settings, DEFAULT_SETTINGS),
        getJSON(env, KEYS.background, null),
      ]);
      return json({ votes, commitments, settings, background });
    }

    // ---- votes ----
    if (pathname === "/api/vote" && method === "POST") {
      const body = await parseBody(request);
      const commitments = await getJSON(env, KEYS.commitments, DEFAULT_COMMITMENTS);
      if (!commitments.some((c) => c.id === body?.commitmentId)) {
        return json({ error: "Invalid commitmentId" }, 400);
      }
      const votes = await getJSON(env, KEYS.votes, []);
      votes.push({ id: makeId(), commitmentId: body.commitmentId, timestamp: Date.now() });
      await putJSON(env, KEYS.votes, votes);
      return json({ success: true, count: votes.length });
    }

    if (pathname === "/api/votes" && method === "GET") {
      return json({ votes: await getJSON(env, KEYS.votes, []) });
    }

    if (pathname === "/api/votes" && method === "DELETE") {
      const body = await parseBody(request);
      if (!checkPin(env, body)) return json({ error: "Unauthorized" }, 401);
      await putJSON(env, KEYS.votes, []);
      return json({ success: true });
    }

    const voteMatch = pathname.match(/^\/api\/vote\/([^/]+)$/);
    if (voteMatch && VOTE_ID.test(voteMatch[1]) && (method === "PATCH" || method === "DELETE")) {
      const voteId = voteMatch[1];
      const body = await parseBody(request);
      if (!checkPin(env, body)) return json({ error: "Unauthorized" }, 401);

      const votes = await getJSON(env, KEYS.votes, []);

      if (method === "DELETE") {
        await putJSON(env, KEYS.votes, votes.filter((v) => v.id !== voteId));
        return json({ success: true });
      }

      const commitments = await getJSON(env, KEYS.commitments, DEFAULT_COMMITMENTS);
      if (!commitments.some((c) => c.id === body?.commitmentId)) {
        return json({ error: "Invalid commitmentId" }, 400);
      }
      const target = votes.find((v) => v.id === voteId);
      if (!target) return json({ error: "Not found" }, 404);
      target.commitmentId = body.commitmentId;
      await putJSON(env, KEYS.votes, votes);
      return json({ success: true });
    }

    // ---- commitments (the pledge options) ----
    if (pathname === "/api/commitments" && method === "GET") {
      return json({ commitments: await getJSON(env, KEYS.commitments, DEFAULT_COMMITMENTS) });
    }

    if (pathname === "/api/commitments" && method === "PUT") {
      const body = await parseBody(request);
      if (!checkPin(env, body)) return json({ error: "Unauthorized" }, 401);
      const clean = sanitizeCommitments(body?.commitments);
      if (!clean) return json({ error: "Invalid commitments" }, 400);
      await putJSON(env, KEYS.commitments, clean);
      return json({ success: true, commitments: clean });
    }

    // ---- settings (campaign branding + goal) ----
    if (pathname === "/api/settings" && method === "GET") {
      return json({ settings: await getJSON(env, KEYS.settings, DEFAULT_SETTINGS) });
    }

    if (pathname === "/api/settings" && method === "PUT") {
      const body = await parseBody(request);
      if (!checkPin(env, body)) return json({ error: "Unauthorized" }, 401);
      const current = await getJSON(env, KEYS.settings, DEFAULT_SETTINGS);
      const next = sanitizeSettings(body?.settings, current);
      await putJSON(env, KEYS.settings, next);
      return json({ success: true, settings: next });
    }

    // ---- background image (display screen backdrop) ----
    if (pathname === "/api/background" && method === "GET") {
      return json({ background: await getJSON(env, KEYS.background, null) });
    }

    if (pathname === "/api/background" && method === "PUT") {
      const body = await parseBody(request);
      if (!checkPin(env, body)) return json({ error: "Unauthorized" }, 401);
      const dataUrl = body?.dataUrl;
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
        return json({ error: "Invalid image" }, 400);
      }
      if (dataUrl.length > 5_000_000) {
        return json({ error: "Image too large" }, 413);
      }
      await putJSON(env, KEYS.background, dataUrl);
      return json({ success: true });
    }

    if (pathname === "/api/background" && method === "DELETE") {
      const body = await parseBody(request);
      if (!checkPin(env, body)) return json({ error: "Unauthorized" }, 401);
      await env.VOTES_KV.delete(KEYS.background);
      return json({ success: true });
    }

    return json({ error: "Not found" }, 404);
  },
};
