# Deploying Courage Wall

Courage Wall has two deployable pieces:

- **Backend** — `worker.js`, a Cloudflare Worker backed by a KV namespace.
- **Frontend** — `courage-wall-production.html`, a static single-page app deployed on Cloudflare Pages.

Target domain: `courage.tomhawkins.me`

## Prerequisites

- A Cloudflare account with the `tomhawkins.me` zone added.
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed and authenticated:
  ```bash
  npm install -g wrangler
  wrangler login
  ```

## 1. Create the KV namespace

```bash
wrangler kv namespace create VOTES_KV
```

Copy the `id` from the output into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

## 2. Deploy the Worker

```bash
wrangler deploy
```

This publishes `worker.js` to your `*.workers.dev` subdomain (e.g. `courage-wall.<you>.workers.dev`).

### Optional: put the API on the custom domain

To serve the API from `courage.tomhawkins.me/api/*` instead of a `workers.dev` URL, uncomment the `routes` block in `wrangler.toml` and redeploy:

```toml
routes = [
  { pattern = "courage.tomhawkins.me/api/*", zone_name = "tomhawkins.me" }
]
```

If you do this, the frontend can leave `API_BASE_URL` empty (relative `/api/...` calls will work automatically, since Pages and the Worker route share the same domain).

### Optional: change the admin PIN

Edit `ADMIN_PIN` under `[vars]` in `wrangler.toml`, and update the matching `ADMIN_PIN` constant in `courage-wall-production.html`. Redeploy the Worker after changing it. For anything beyond a casual event PIN, set it as a Wrangler secret instead of a plaintext var:

```bash
wrangler secret put ADMIN_PIN
```

## 3. Point the frontend at the Worker

Open `courage-wall-production.html` and set the API base URL near the top of the `<script>` block:

```html
<script>
  window.COURAGE_WALL_API_BASE = "https://courage-wall.<you>.workers.dev";
</script>
```

Add this `<script>` tag just before the existing script tag in the file — or, if you routed the Worker onto the custom domain in step 2, leave `COURAGE_WALL_API_BASE` unset and skip this.

## 4. Deploy the frontend to Cloudflare Pages

```bash
wrangler pages deploy . --project-name=courage-wall
```

(Or connect the repo to Pages in the dashboard and set the build output directory to the repo root — no build step is required, it's a static HTML file.)

In the Pages project settings, set the **production file** to `courage-wall-production.html`, or rename/copy it to `index.html` for the deploy.

## 5. Attach the custom domain

In the Cloudflare Pages project → **Custom domains**, add `courage.tomhawkins.me` and follow the DNS prompts (Cloudflare will create the CNAME automatically since the zone is already on your account).

## 6. Verify

- Visit `https://courage.tomhawkins.me/` — the voter view should load and submitting a commitment should succeed.
- Visit `https://courage.tomhawkins.me/?view=display` — votes should appear within ~1 second of being submitted.
- Visit `https://courage.tomhawkins.me/?view=admin`, enter the PIN, and confirm stats, the QR code, and the reset button all work.

## Known limitations

- Votes are stored as a single JSON array under one KV key. This keeps the app simple but means concurrent writes are read-modify-write, not atomic — under heavy simultaneous traffic a small number of votes could race and overwrite each other. Fine for a single-event display; consider Durable Objects if you need strict consistency at scale.
- The admin PIN is a shared constant, not a per-user credential. It gates the reset endpoint on the backend, but only lightly gates the frontend admin view. Don't reuse it for anything sensitive.
