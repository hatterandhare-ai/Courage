/**
 * Courage Wall — Cloudflare Worker backend
 *
 * Storage: a single Cloudflare KV namespace (binding VOTES_KV).
 * commitments, settings, and background are each one JSON value under a
 * fixed key — fine as-is, since only the (single) admin ever writes them.
 * Votes are different: many people submit pledges within the same few
 * seconds at a real event, so each pledge gets its OWN key ("vote:<id>")
 * instead of living in one shared JSON array. A shared array requires
 * read-modify-write on every single vote, and concurrent submissions
 * racing that read-modify-write silently lose pledges — confirmed while
 * testing this locally: 30 concurrent votes landed only 5. Giving each
 * vote its own key makes every write independent, so there's nothing
 * left to race.
 *
 * Endpoints:
 *   GET    /api/state                                   -> { votes, commitments, settings, background, pledgeBackground }
 *                                                            (combined read, meant for polling)
 *
 *   POST   /api/vote        { commitmentId } or { text }   -> add a pledge (public) — a preset
 *                                                            pick or a custom pledge (randomly
 *                                                            colored server-side)
 *   GET    /api/votes                                    -> { votes: [...] }
 *   PATCH  /api/vote/:id    { pin, commitmentId|text }    -> edit one pledge (admin)
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
 *   GET    /api/pledge-background                         -> { pledgeBackground }
 *   PUT    /api/pledge-background { pin, dataUrl }         -> set the pledge screen's background image (admin)
 *   DELETE /api/pledge-background { pin }                  -> clear the pledge screen's background image (admin)
 *
 * Set ADMIN_PIN via wrangler.toml [vars] or a secret; falls back to "1234".
 */

const KEYS = {
  commitments: "commitments",
  settings: "settings",
  background: "background",
  pledgeBackground: "pledgeBackground",
};
const VOTE_PREFIX = "vote:";

// Two background image slots, same shape and rules, different screens.
const BACKGROUND_ROUTES = {
  "/api/background": KEYS.background,
  "/api/pledge-background": KEYS.pledgeBackground,
};
function jsonKeyFor(pathname) {
  return pathname === "/api/pledge-background" ? "pledgeBackground" : "background";
}

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
  // "preset" = pick one of the commitments above; "custom" = write your
  // own pledge, colored randomly from RANDOM_PLEDGE_COLORS below.
  pledgeMode: "preset",
};

// Colors assigned to custom-written pledges, one at random per pledge.
// A superset of the preset commitment colors (plus a couple more) rather
// than a truly arbitrary RGB pick, so custom pledges still read as part
// of the same visual system instead of clashing with it.
const RANDOM_PLEDGE_COLORS = [
  "#7c3aed", "#3b82f6", "#10b981", "#f59e0b", "#f97316", "#ef4444", "#ec4899", "#14b8a6",
];

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

// Reads every vote:* key (paginating past KV's 1000-keys-per-list-call
// limit if there are that many), fetching values in parallel. list()
// returns keys in lexicographic order, not creation order, so the
// result is explicitly sorted by timestamp afterward.
async function listAllVotes(env) {
  const votes = [];
  let cursor;
  do {
    const page = await env.VOTES_KV.list({ prefix: VOTE_PREFIX, cursor, limit: 1000 });
    const values = await Promise.all(page.keys.map((k) => env.VOTES_KV.get(k.name)));
    for (const raw of values) {
      if (!raw) continue;
      try {
        votes.push(JSON.parse(raw));
      } catch (err) {
        // skip a corrupt entry rather than fail the whole read
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  votes.sort((a, b) => a.timestamp - b.timestamp);
  return votes;
}

async function deleteAllVotes(env) {
  let cursor;
  do {
    const page = await env.VOTES_KV.list({ prefix: VOTE_PREFIX, cursor, limit: 1000 });
    await Promise.all(page.keys.map((k) => env.VOTES_KV.delete(k.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
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
    pledgeMode: incoming?.pledgeMode === "custom" || incoming?.pledgeMode === "preset" ? incoming.pledgeMode : current.pledgeMode,
  };
}

function sanitizePledgeText(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim().slice(0, 100);
  return trimmed.length > 0 ? trimmed : null;
}

function randomPledgeColor() {
  return RANDOM_PLEDGE_COLORS[Math.floor(Math.random() * RANDOM_PLEDGE_COLORS.length)];
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
      const [votes, commitments, settings, background, pledgeBackground] = await Promise.all([
        listAllVotes(env),
        getJSON(env, KEYS.commitments, DEFAULT_COMMITMENTS),
        getJSON(env, KEYS.settings, DEFAULT_SETTINGS),
        getJSON(env, KEYS.background, null),
        getJSON(env, KEYS.pledgeBackground, null),
      ]);
      return json({ votes, commitments, settings, background, pledgeBackground });
    }

    // ---- votes ----
    // A pledge is either { commitmentId } (picked one of the preset
    // options) or { text } (wrote their own, colored randomly server-side
    // so the color can't be spoofed by the client). Which shape a
    // request uses is inferred from its body, not from the *current*
    // settings.pledgeMode — that way a submission already in flight when
    // the admin flips the mode still saves correctly instead of failing.
    if (pathname === "/api/vote" && method === "POST") {
      const body = await parseBody(request);
      const id = makeId();

      if (typeof body?.text === "string") {
        const text = sanitizePledgeText(body.text);
        if (!text) return json({ error: "Invalid pledge text" }, 400);
        await putJSON(env, VOTE_PREFIX + id, { id, text, color: randomPledgeColor(), timestamp: Date.now() });
        return json({ success: true });
      }

      const commitments = await getJSON(env, KEYS.commitments, DEFAULT_COMMITMENTS);
      if (!commitments.some((c) => c.id === body?.commitmentId)) {
        return json({ error: "Invalid commitmentId" }, 400);
      }
      // Its own key — never contends with any other vote's write.
      await putJSON(env, VOTE_PREFIX + id, { id, commitmentId: body.commitmentId, timestamp: Date.now() });
      return json({ success: true });
    }

    if (pathname === "/api/votes" && method === "GET") {
      return json({ votes: await listAllVotes(env) });
    }

    if (pathname === "/api/votes" && method === "DELETE") {
      const body = await parseBody(request);
      if (!checkPin(env, body)) return json({ error: "Unauthorized" }, 401);
      await deleteAllVotes(env);
      return json({ success: true });
    }

    const voteMatch = pathname.match(/^\/api\/vote\/([^/]+)$/);
    if (voteMatch && VOTE_ID.test(voteMatch[1]) && (method === "PATCH" || method === "DELETE")) {
      const voteId = voteMatch[1];
      const body = await parseBody(request);
      if (!checkPin(env, body)) return json({ error: "Unauthorized" }, 401);
      const key = VOTE_PREFIX + voteId;

      if (method === "DELETE") {
        await env.VOTES_KV.delete(key);
        return json({ success: true });
      }

      const target = await getJSON(env, key, null);
      if (!target) return json({ error: "Not found" }, 404);

      // PATCH replaces the pledge's shape entirely (never a mix of both)
      // — editing its text keeps the pledge a custom one, editing its
      // commitmentId keeps it a preset one.
      if (typeof body?.text === "string") {
        const text = sanitizePledgeText(body.text);
        if (!text) return json({ error: "Invalid pledge text" }, 400);
        await putJSON(env, key, { id: target.id, text, color: target.color || randomPledgeColor(), timestamp: target.timestamp });
        return json({ success: true });
      }

      const commitments = await getJSON(env, KEYS.commitments, DEFAULT_COMMITMENTS);
      if (!commitments.some((c) => c.id === body?.commitmentId)) {
        return json({ error: "Invalid commitmentId" }, 400);
      }
      await putJSON(env, key, { id: target.id, commitmentId: body.commitmentId, timestamp: target.timestamp });
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

    // ---- background images (display wall backdrop, and separately the
    // pledge screen's) — same shape, same rules, just two KV keys ----
    const bgKey = BACKGROUND_ROUTES[pathname];
    if (bgKey && method === "GET") {
      return json({ [jsonKeyFor(pathname)]: await getJSON(env, bgKey, null) });
    }

    if (bgKey && method === "PUT") {
      const body = await parseBody(request);
      if (!checkPin(env, body)) return json({ error: "Unauthorized" }, 401);
      const dataUrl = body?.dataUrl;
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
        return json({ error: "Invalid image" }, 400);
      }
      if (dataUrl.length > 5_000_000) {
        return json({ error: "Image too large" }, 413);
      }
      await putJSON(env, bgKey, dataUrl);
      return json({ success: true });
    }

    if (bgKey && method === "DELETE") {
      const body = await parseBody(request);
      if (!checkPin(env, body)) return json({ error: "Unauthorized" }, 401);
      await env.VOTES_KV.delete(bgKey);
      return json({ success: true });
    }

    return json({ error: "Not found" }, 404);
  },
};
