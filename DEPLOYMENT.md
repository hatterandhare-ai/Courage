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

## Automated deploys (GitHub Actions)

`.github/workflows/deploy.yml` deploys both the Worker and the frontend on every push to `claude/courage-wall-setup-lowwhf` (or on a manual "Run workflow"). It needs two repository secrets:

- `CLOUDFLARE_API_TOKEN` — an API token with `Workers Scripts:Edit`, `Workers KV Storage:Edit`, and `Cloudflare Pages:Edit` permissions for your account.
- `CLOUDFLARE_ACCOUNT_ID` — found in the Cloudflare dashboard sidebar, or via `wrangler whoami`.

Add both under the repo's **Settings → Secrets and variables → Actions**. Once set, pushing to that branch runs `wrangler deploy` for the Worker, then builds `dist/index.html` (the production HTML with a `<script>` tag pointing at the Worker's freshly-deployed `*.workers.dev` URL) and runs `wrangler pages deploy dist --project-name=courage-wall`.

The workflow only needs updating if the Worker gets routed onto the same custom domain as the Pages site (see step 2 below) — at that point the URL-injection step becomes unnecessary and can be dropped, since relative `/api/...` calls will work instead.

The steps below are for deploying manually instead (or for the one-time custom-domain setup in step 5, which isn't automatable).

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

The easiest way is from the app itself: **Admin → Admin access → Update PIN**. That writes the new PIN to KV, where it takes precedence over `ADMIN_PIN` from then on — no redeploy needed.

`ADMIN_PIN` under `[vars]` in `wrangler.toml` (or a Wrangler secret) only sets the *bootstrap* PIN used before an admin ever sets one in KV:

```bash
wrangler secret put ADMIN_PIN
```

**Forgot the PIN you set in-app?** Delete the `pin` key from the KV namespace to fall back to `ADMIN_PIN` again:

```bash
wrangler kv key delete --namespace-id=<your-namespace-id> pin
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

- Visit `https://courage.tomhawkins.me/` (or `?view=pledge`) — the pledge view should load and submitting a commitment should succeed.
- Visit `https://courage.tomhawkins.me/?view=display` — pledges should appear within ~1 second of being submitted, since the display polls `GET /api/state` every second.
- Visit `https://courage.tomhawkins.me/?view=admin`, enter the PIN, and confirm stats, the pledge list (edit/remove), the pledge options editor, the pledge mode toggle, campaign branding fields, the goal toggle, the two background uploads (display and pledge screen), the QR code, and reset all work.
- Toggle **Pledge mode** to "Let people write their own" and confirm the pledge view swaps to a free-text box, submissions get a random color, and the display/admin views render them correctly (including falling back to a single aggregated "Custom pledges" card, instead of six empty preset cards, once there are enough pledges to need the summary view).
- Click **Export board as PDF** in the admin panel and confirm it opens `?view=print` in a new tab, renders every pledge as a sticky note (not clipped to one screen, not the category-summary fallback), and triggers the browser's print dialog — "Save as PDF" there is the actual export. Adding a pledge on the live display should only animate the new note in, not replay the drop-in animation for the whole board.
- Everything starts blank: the campaign fields (eyebrow/title/tagline) and all six pledge option labels are empty until an admin fills them in — confirm the pledge/display views hold up with blank text (they will, since nothing renders a hardcoded fallback) and that the option editor still shows helpful greyed-out example placeholder text per field.
- In **Admin → Admin access**, set a new PIN, then reload `?view=admin` in a fresh tab and confirm the *old* PIN no longer unlocks it and the *new* one does.

## API surface

Beyond the original vote/reset endpoints, the Worker now also serves the pledge options, campaign branding, goal setting, display background, and the admin PIN itself — see the comment block at the top of `worker.js` for the full list. `GET /api/state` returns most of it in one call and is what the display and admin views poll; individual `GET`/`PUT`/`PATCH`/`DELETE` endpoints exist per resource for the admin panel's actions. Everything except `POST /api/vote`, `POST /api/verify-pin`, and the `GET` endpoints requires the PIN in the request body. `POST /api/verify-pin` exists solely to gate the admin unlock screen now that the PIN can change at runtime — it never mutates anything and isn't part of `GET /api/state` (the current PIN itself is never returned by any endpoint, only checked).

## Known limitations

- Pledge options, campaign settings, and the background image are each stored as one JSON value under one KV key apiece — read-modify-write, not atomic. Fine here, since only the (single) admin ever writes them; there's no realistic concurrent-write scenario. Votes don't have this problem: each pledge gets its own KV key specifically so simultaneous submissions from many people never contend with each other (confirmed by testing concurrent writes locally, both before and after that change — see the commit that introduced it).
- Cloudflare KV is eventually consistent — a write can take a little while (typically seconds, occasionally up to ~60s) to propagate to every edge location. For a single in-person event this is rarely noticeable, but don't expect instant global consistency.
- The background image is stored as a data URL directly in KV (capped at 5MB server-side; the admin panel downscales uploads client-side to stay well under that). For very large images or many campaigns' worth of assets, consider moving this to R2 instead.
- The admin PIN is a single shared secret, not a per-user credential — everyone with it has full admin access, and there's no audit trail of who changed what. It gates every mutating endpoint on the backend. Don't reuse it for anything sensitive.
