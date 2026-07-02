# Social Media MCP

A generic MCP server for creating, publishing, scheduling, and analyzing
social media posts across multiple brands from ChatGPT (or any MCP client).

**Blotato is the first provider, not the architecture.** Every tool talks to
a `SocialProvider` interface (`src/providers/types.ts`). The Blotato-specific
HTTP calls live in one file (`src/providers/blotato.ts`). To add Buffer,
Metricool, Hootsuite, or Meta directly later, implement that same interface
in a new file and register it in `src/providers/index.ts` — no tool code
changes.

## What's implemented

Two entrypoints, same tools, same brands, same provider:

- `src/index.ts` (`npm start`) — stdio transport, for local MCP clients that
  spawn a subprocess: Claude Desktop, Claude Code, Cursor.
- `src/http.ts` (`npm run start:http`) — Streamable HTTP transport at
  `/mcp`, for remote clients: **this is the one ChatGPT needs.** ChatGPT
  can't spawn a local process, so it requires an MCP server reachable over
  HTTPS. See "Connecting to ChatGPT" below.

Both just call `createServer()` in `src/server.ts`, which is where every
tool is actually defined — there's exactly one copy of the tool logic.

Tools (`src/server.ts`):

- `listBrands` — every configured brand, voice, connected platforms
- `getBrand` — one brand's Facebook Page ID, Instagram Account ID, TikTok Account ID, voice, logo, website
- `listConnectedAccounts` — raw provider account list (setup/discovery helper, see below)
- `createPost` — composes caption + hashtags into a draft, returns a `draftId`
- `publishPost` — publish now, to one or more platforms, auto-resolving the brand's account/page IDs
- `schedulePost` — schedule to a date/time or the next open calendar slot
- `editScheduledPost` — change caption/hashtags/image/time on an existing scheduled post
- `deleteScheduledPost` — cancel a scheduled post
- `listScheduledPosts` — filterable by brand and/or platform
- `getAnalytics` — reach, impressions, likes, shares, comments, clicks (per post or top performers)

Brands (`src/brands.ts`): Jennifer's Personal Page, The Boarding Group,
Safeguard Financial, and Focused Photobooths are fully configured from the
IDs you provided. Atlas AI, Tax Compliance Pro, PayoutPro, Chilling With
Friends, Fleet Three Eighty Five, Stay N Tha Game, and Say It Threads (your
Connected Accounts screen shows this Page as "Say It Threads" — I renamed it
from "St8ment Threads" to match; flag it if that's actually a different
brand) are pre-listed as **disabled** placeholders — fill in their real IDs
and flip `enabled: true` to activate them. No other code changes needed.

The shared Facebook login `accountId` (39452) is baked in as the default in
`src/brands.ts`, still overridable via `BLOTATO_FACEBOOK_ACCOUNT_ID` if that
connection is ever regenerated. Your Connected Accounts screenshot confirms
this: one Facebook login ("Jennifer Lewis") administers every brand's Page,
including Chilling With Friends and Say It Threads — so once you add their
Page IDs, no other Facebook config is needed for them either.

**Getting the remaining Page IDs.** Chilling With Friends and Say It Threads
already show Facebook Pages connected in Blotato — they just need their
numeric Page ID pasted into `src/brands.ts`. Two ways to get it:
1. Click "Copy Page ID" next to that Page's name in Blotato's Connected
   Accounts screen, or
2. Once the server is running with your API key, call
   `listConnectedAccounts` with `accountId: "39452"` — it returns every
   connected Facebook Page and its `id` (the Page ID) in one call.

**Jennifer's Personal Page — one gap:** you gave a Facebook *account* ID
(39452) but not a Facebook *Page* ID for this brand. Blotato requires
`pageId` on every Facebook post, no exceptions. If this is a Facebook Page,
run `listConnectedAccounts` → subaccounts to get its Page ID and add it to
`accounts.facebook` in `src/brands.ts`. Until then, `publishPost`/
`schedulePost` to `"facebook"` for `jennifer_personal` will fail with a clear
error from Blotato — Instagram and TikTok for this brand work today.

## Setup

1. Install Node.js 20+.
2. `npm install`
3. Copy `.env.example` to `.env` and set `BLOTATO_API_KEY` — from
   [my.blotato.com/settings](https://my.blotato.com/settings) > API. Paste
   the key only into this local `.env` file, never into chat — see the
   security note below.
4. `npm run build`
5. `npm start` (or point your MCP client at `dist/index.js` directly — see config example below)

## MCP client configuration example

```json
{
  "mcpServers": {
    "social-media": {
      "command": "node",
      "args": ["/absolute/path/to/social-media-mcp/dist/index.js"],
      "env": {
        "SOCIAL_PROVIDER": "blotato",
        "BLOTATO_API_KEY": "your_key_here"
      }
    }
  }
}
```

## Connecting to ChatGPT

ChatGPT cannot use the stdio config above — it needs the HTTP entrypoint
(`src/http.ts`) running somewhere reachable over HTTPS. Here's a concrete
path using [Render](https://render.com) (free tier works for testing; a
paid instance avoids cold-start delays in production). Railway or Fly.io
work the same way if you prefer those.

**1. Push this project to a Git repo** (GitHub/GitLab) — Render deploys from
a repo, not a zip upload.

**2. Create a Render Web Service:**
- New -> Web Service -> connect the repo.
- Build command: `npm install && npm run build`
- Start command: `npm run start:http`
- Instance type: the free tier is fine to start.

**3. Set environment variables** in Render's dashboard (Settings ->
Environment):
- `BLOTATO_API_KEY` - your Blotato key
- `MCP_HTTP_AUTH_TOKEN` - make up a long random string yourself (e.g. `openssl rand -hex 32`). This is what stops random people on the internet from posting to your brands through this URL. **Do not skip this** - without it the endpoint is wide open.
- `SOCIAL_PROVIDER=blotato` (optional, it's already the default)

Render sets `PORT` automatically - the server already reads it.

**4. Deploy.** Render gives you a URL like `https://social-media-mcp.onrender.com`. Confirm it's up: `https://social-media-mcp.onrender.com/healthz` should return `{"status":"ok"}`.

**5. Add the connector in ChatGPT:**
- Settings -> Apps & Connectors -> Advanced settings -> turn on Developer mode (if your org allows it).
- Settings -> Apps & Connectors -> Create.
- Connector URL: `https://social-media-mcp.onrender.com/mcp`
- Authentication: paste the same value you set for `MCP_HTTP_AUTH_TOKEN` as the API token.
- Save - ChatGPT will list the 10 tools if the connection succeeds.

**6. Use it:** in a ChatGPT chat, click **+** -> **More** -> select the connector, then prompt normally ("Create a post for The Boarding Group announcing the Paris trip" etc.). Write actions (publish/schedule/edit/delete) will ask you to confirm before running unless you choose to remember approvals for the conversation.

**Local testing before you deploy anywhere:** run `npm run dev:http` and expose it temporarily with `ngrok http 3000` (or OpenAI's own [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)) - point the connector at the tunnel's HTTPS URL instead of a Render URL. Good for trying it out today; switch to real hosting once you're happy with it, since tunnel URLs aren't durable.

## Design notes / things your developer should know

- **Provider abstraction.** `src/providers/index.ts` picks the provider from
  `SOCIAL_PROVIDER` (default `blotato`). Tools never import Blotato code
  directly — only `getProvider()`.
- **Brand → account resolution.** `resolveAccount(brand, platform)` in
  `src/brands.ts` is the single place that maps a brand name to the correct
  Facebook Page ID / Instagram Account ID / TikTok Account ID. Nobody ever
  types an ID into a chat message.
- **Drafts are in-memory only.** `createPost` doesn't call Blotato — Blotato
  has no "draft" concept in its API (a post is either published or
  scheduled). `createPost` validates and composes the content and hands back
  a `draftId` for the current server session. If you need drafts to survive
  a server restart, swap `src/drafts.ts`'s `Map` for a small file or database
  — nothing else needs to change.
- **Scheduling time format.** `schedulePost`/`editScheduledPost` take plain
  `date` (`YYYY-MM-DD`), `time` (`HH:MM`), and `timezoneOffset` (e.g.
  `-04:00` for US Eastern Daylight Time; defaults to `Z`/UTC). This avoids
  depending on an IANA timezone database inside the MCP server. If your
  brands post from a fixed timezone, tell your developer to set a project
  default for `timezoneOffset` instead of passing UTC.
- **`editScheduledPost` fetches before it patches.** Blotato's `PATCH
  /schedules/:id` does not merge partial updates — you must resend the whole
  draft. `BlotatoProvider.editScheduledPost` fetches the current schedule
  first and only overrides the fields you actually passed.
- **`getAnalytics` brand filtering is best-effort.** Blotato's analytics
  endpoints filter by platform and date range, not by connected account. If
  you ask for analytics scoped to a brand, the tool validates the brand
  exists but returns platform-level results — cross-check the returned
  `postUrl` to confirm which brand a given post belongs to. A cleaner fix
  later: have Blotato support (or a future provider) expose account-scoped
  analytics.
- **No hardcoded secrets.** `BLOTATO_API_KEY` is read from `process.env`
  only, checked lazily on first API call (not at server startup), so the
  server still boots and `listBrands`/`getBrand` still work even before a key
  is configured.
- **Images: URL, upload, or ChatGPT-generated — all three work.** The
  `image` param on `createPost`/`publishPost`/`schedulePost`/`editScheduledPost`
  accepts either a plain public URL string, or ChatGPT's file-reference shape
  `{ download_url, file_id }`. Those four tools are marked with
  `_meta["openai/fileParams"]: ["image"]` in `src/server.ts`, which is what
  tells ChatGPT to actually populate that field with a real file — a user
  upload or a just-generated image — instead of leaving it to the model to
  invent a URL. `resolveImageUrl()` in `src/server.ts` handles both cases:
  a plain string passes through untouched; a file reference gets downloaded
  from ChatGPT's temporary `download_url` and re-uploaded to Blotato's own
  storage via `SocialProvider.uploadMediaFromBytes` (Blotato's presigned
  upload flow), so publishing always ends up with a URL Blotato's servers can
  actually fetch. This is also why the earlier "caption posted but image
  didn't" issue happened — a ChatGPT-internal URL isn't publicly fetchable by
  Blotato directly, it has to be relayed through our server first.
- **HTTP auth is a shared bearer token, not OAuth.** `src/http.ts` checks
  every request's `Authorization: Bearer <MCP_HTTP_AUTH_TOKEN>` header. This
  is the "paste an API token" auth mode ChatGPT's connector setup supports
  natively, and is enough for a single-user/single-org deployment. If this
  ever needs to support multiple people with separately revocable access,
  swap it for real OAuth (`src/apps-sdk` "Authenticate users" guide covers
  the pattern) - nothing else in the tool code needs to change.
- **TikTok requires 7 extra fields on every post** (`privacyLevel`,
  `disabledComments`, `disabledDuet`, `disabledStitch`, `isBrandedContent`,
  `isYourBrand`, `isAiGenerated`) — TikTok's API rejects posts missing any of
  them. `publishPost`/`schedulePost` accept these as a `tiktokOptions` object
  and throw a clear error up front if you target `"tiktok"` without it,
  rather than letting a vague 422 come back from Blotato.

## Security note

You confirmed you already rotated the Blotato API key referenced in the
starter project's README — good, that closes the loop on the earlier
exposure concern. I don't need the key itself; paste it only into your local
`.env` file (never into this chat), keep `.env` out of version control, and
your MCP client will pick it up from there.

## Phase 2 (not built yet, per your spec)

Canva integration, AI-generated reels/carousels, RSS monitoring for
auto-promoting new trips, weekly content calendar generation, an analytics
dashboard, cross-posting, and an approval workflow are all out of scope for
this pass. The provider abstraction and brand registry are built so none of
that work requires reworking the publishing core.
