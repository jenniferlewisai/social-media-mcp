// Generic Social Media MCP server — tool definitions.
//
// createServer() builds a fresh McpServer with every tool registered. Tool
// code below only ever talks to two things: the brand registry
// (src/brands.ts) and the SocialProvider interface (src/providers). It never
// references Blotato directly — that keeps the whole server portable to a
// different publishing provider by changing SOCIAL_PROVIDER, with zero tool
// changes.
//
// This is a factory (not a module-level singleton) because the HTTP
// transport (src/http.ts) needs one McpServer instance per client session;
// the stdio transport (src/index.ts) just calls it once.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { BRANDS, BRAND_KEYS, getBrandOrThrow, resolveAccount } from "./brands.js";
import { composeCaption, createDraft, getDraft } from "./drafts.js";
import { getProvider, PLATFORMS, type SocialProvider } from "./providers/index.js";

const BrandKeySchema = z.enum(BRAND_KEYS);
const PlatformSchema = z.enum(PLATFORMS);

// ---------------------------------------------------------------------------
// Image input: accepts either a plain public URL, or a ChatGPT file
// reference. When a tool marks a field in _meta["openai/fileParams"],
// ChatGPT is supposed to populate that field with { download_url, file_id }
// for any file the user uploaded/attached or any image the model generated
// in the conversation — this is the mechanism, per OpenAI's Apps SDK
// reference, for handing a real file to an MCP tool instead of a URL string
// the model made up. download_url is a temporary link scoped to ChatGPT's
// own infrastructure, not a public URL Blotato's servers can fetch — so
// resolveImageUrl() downloads it here and re-uploads the bytes to the
// provider's own storage to get a URL that's actually publicly fetchable.
//
// IMPORTANT — schema is intentionally z.any(), not a strict union:
// the fileParams download_url/file_id substitution is NOT 100% reliable in
// practice. OpenAI's own developer community has documented cases where a
// strictly-typed union field (string().url() | object) causes the tool call
// to be rejected outright, and/or the raw internal path of the generated
// image (e.g. "/mnt/data/foo.png") leaks through unsubstituted. The fix
// confirmed by OpenAI staff/community is to type file-param fields as
// z.any() so the call always reaches the server, and validate the actual
// shape at runtime instead — which is what resolveImageUrl() does below,
// with a clear, actionable error message when the image genuinely can't be
// resolved (instead of an opaque schema-validation rejection).
// ---------------------------------------------------------------------------
const ImageFileRefSchema = z.object({
  download_url: z.string().url(),
  file_id: z.string().optional(),
  mime_type: z.string().optional(),
  file_name: z.string().optional()
});
const ImageInputSchema = z.any().optional();
type ImageInput = unknown;

function isPublicHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function resolveImageUrl(image: ImageInput, provider: SocialProvider): Promise<string[]> {
  if (image === undefined || image === null || image === "") return [];

  // Already a plain public URL (manually supplied, or from an earlier step) — use as-is.
  if (typeof image === "string") {
    if (isPublicHttpUrl(image)) return [image];

    // ChatGPT occasionally fails to substitute the fileParams object and
    // instead hands us the raw internal path of a generated/attached image
    // (e.g. "/mnt/data/foo.png" or a "sandbox:" URI). That path only exists
    // inside ChatGPT's own sandbox — this server has no way to fetch it —
    // so fail loudly with guidance instead of a confusing network error or
    // silently dropping the image.
    throw new Error(
      `Received "${image}" as the image, which is neither a public URL nor a ChatGPT file reference. This ` +
        `usually means ChatGPT wasn't able to hand over the generated/attached image as a file (a known Apps SDK ` +
        `limitation for inline-generated images). Try attaching the image as a file in the chat rather than ` +
        `leaving it inline, or pass a publicly accessible image URL instead.`
    );
  }

  const parsed = ImageFileRefSchema.safeParse(image);
  if (!parsed.success) {
    throw new Error(
      `Received an image value in a shape this server doesn't recognize (expected a public URL string, or ` +
        `{ download_url, file_id } from ChatGPT). Got: ${JSON.stringify(image)}`
    );
  }
  const fileRef = parsed.data;

  // A ChatGPT file reference — fetch the bytes from the temporary download
  // URL, then re-upload to the provider so we end up with a URL the
  // provider's own publish call can actually reach.
  let response: Response;
  try {
    response = await fetch(fileRef.download_url);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not reach the image's download_url (${reason}). The link may have expired — try re-attaching the image.`
    );
  }
  if (!response.ok) {
    throw new Error(
      `Failed to download the image from ChatGPT (status ${response.status}). The download_url may have expired — try re-attaching the image.`
    );
  }
  const contentType = fileRef.mime_type ?? response.headers.get("content-type") ?? "application/octet-stream";
  const bytes = new Uint8Array(await response.arrayBuffer());
  const extension = contentType.split("/")[1]?.split(";")[0] || "bin";
  const filename = fileRef.file_name ?? `${fileRef.file_id ?? "chatgpt-image"}.${extension}`;

  const publicUrl = await provider.uploadMediaFromBytes(bytes, filename, contentType);
  return [publicUrl];
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "social-media-mcp", version: "1.0.0" });

  // ---------------------------------------------------------------------------
  // listBrands
  // ---------------------------------------------------------------------------
  server.tool(
    "listBrands",
    "List every configured brand (including not-yet-connected future brands), with brand voice and which platforms are connected.",
    {},
    async () => {
      const items = Object.values(BRANDS).map((b) => ({
        key: b.key,
        displayName: b.displayName,
        enabled: b.enabled,
        voice: b.voice,
        platforms: Object.keys(b.accounts)
      }));
      return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
    }
  );

  // ---------------------------------------------------------------------------
  // getBrand
  // ---------------------------------------------------------------------------
  server.tool(
    "getBrand",
    "Get one brand's full profile: Facebook Page ID, Instagram Account ID, TikTok Account ID, brand voice, logo path, and website.",
    { brand: BrandKeySchema },
    async ({ brand }) => {
      const b = getBrandOrThrow(brand);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                key: b.key,
                displayName: b.displayName,
                facebookPageId: b.accounts.facebook?.pageId ?? null,
                instagramAccountId: b.accounts.instagram?.accountId ?? null,
                tiktokAccountId: b.accounts.tiktok?.accountId ?? null,
                brandVoice: b.voice,
                logoPath: b.logoPath ?? null,
                website: b.website ?? null
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  // ---------------------------------------------------------------------------
  // listConnectedAccounts (setup/discovery helper, not in the original 9 but
  // needed to find real Blotato accountIds — see README)
  // ---------------------------------------------------------------------------
  server.tool(
    "listConnectedAccounts",
    'Fetch connected social accounts (raw provider data). Without accountId: lists top-level connected logins (e.g. the shared Facebook login) and every Instagram/TikTok account. With accountId: lists that login\'s subaccounts (Facebook Pages / LinkedIn Company Pages), each with its own pageId. Run with accountId=39452 to get real Page IDs for every connected Facebook Page, including ones not yet in src/brands.ts.',
    {
      platform: PlatformSchema.optional(),
      accountId: z.string().optional().describe("Pass a Facebook/LinkedIn accountId to list its Pages instead of top-level accounts.")
    },
    async ({ platform, accountId }) => {
      const provider = getProvider();
      const data = accountId ? await provider.listSubaccounts(accountId) : await provider.listConnectedAccounts(platform);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ---------------------------------------------------------------------------
  // createPost
  // ---------------------------------------------------------------------------
  server.registerTool(
    "createPost",
    {
      description:
        "Create a draft post for a brand (composes caption + hashtags, resolves the image, validates the brand). Not sent to any platform yet — returns a draftId to pass to publishPost or schedulePost.",
      inputSchema: {
        brand: BrandKeySchema,
        caption: z.string().min(1),
        image: ImageInputSchema.describe(
          "A public image URL, or an image the user uploaded/ChatGPT generated in this conversation."
        ),
        hashtags: z.array(z.string()).optional()
      },
      _meta: { "openai/fileParams": ["image"] }
    },
    async ({ brand, caption, image, hashtags }) => {
      getBrandOrThrow(brand);
      const text = composeCaption(caption, hashtags);
      const mediaUrls = await resolveImageUrl(image, getProvider());
      const draft = createDraft(brand, text, mediaUrls);
      return { content: [{ type: "text", text: JSON.stringify(draft, null, 2) }] };
    }
  );

  // ---------------------------------------------------------------------------
  // shared input resolution for publish/schedule
  // ---------------------------------------------------------------------------
  const InlineOrDraftShape = {
    draftId: z.string().optional().describe("A draftId returned by createPost."),
    brand: BrandKeySchema.optional().describe("Required if draftId is not given."),
    caption: z.string().optional().describe("Required if draftId is not given."),
    image: ImageInputSchema.describe(
      "A public image URL, or an image the user uploaded/ChatGPT generated in this conversation. Ignored if draftId is given (the draft's image is used instead)."
    ),
    hashtags: z.array(z.string()).optional()
  };

  async function resolveContent(input: {
    draftId?: string;
    brand?: string;
    caption?: string;
    image?: ImageInput;
    hashtags?: string[];
  }): Promise<{ brand: string; text: string; mediaUrls: string[] }> {
    if (input.draftId) {
      const draft = getDraft(input.draftId);
      return { brand: draft.brand, text: draft.text, mediaUrls: draft.mediaUrls };
    }
    if (!input.brand || !input.caption) {
      throw new Error("Provide either draftId, or brand + caption.");
    }
    const mediaUrls = await resolveImageUrl(input.image, getProvider());
    return {
      brand: input.brand,
      text: composeCaption(input.caption, input.hashtags),
      mediaUrls
    };
  }

  // TikTok requires all 7 of these fields on every post (Blotato rejects the
  // request otherwise). They're surfaced as one structured optional param
  // rather than a generic passthrough so the AI/caller sees exactly what's
  // required instead of guessing at free-form keys.
  const TikTokOptionsSchema = z
    .object({
      privacyLevel: z.enum(["SELF_ONLY", "PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR"]),
      disabledComments: z.boolean(),
      disabledDuet: z.boolean(),
      disabledStitch: z.boolean(),
      isBrandedContent: z.boolean(),
      isYourBrand: z.boolean(),
      isAiGenerated: z.boolean()
    })
    .optional()
    .describe('Required when platforms includes "tiktok". All 7 fields are required by TikTok\'s API.');

  function buildPlatformOptions(
    platform: string,
    tiktokOptions?: z.infer<typeof TikTokOptionsSchema>
  ): Record<string, unknown> | undefined {
    if (platform !== "tiktok") return undefined;
    if (!tiktokOptions) {
      throw new Error(
        'Publishing to "tiktok" requires tiktokOptions (privacyLevel, disabledComments, disabledDuet, ' +
          "disabledStitch, isBrandedContent, isYourBrand, isAiGenerated) — TikTok's API rejects posts missing any of them."
      );
    }
    return tiktokOptions;
  }

  // ---------------------------------------------------------------------------
  // publishPost
  // ---------------------------------------------------------------------------
  server.registerTool(
    "publishPost",
    {
      description:
        "Publish a post immediately to one or more platforms for a brand. Automatically resolves the correct Facebook Page ID / Instagram Account ID for the brand — never pass IDs manually.",
      inputSchema: {
        ...InlineOrDraftShape,
        platforms: z.array(PlatformSchema).min(1),
        tiktokOptions: TikTokOptionsSchema
      },
      _meta: { "openai/fileParams": ["image"] }
    },
    async (input) => {
      const { brand: brandKey, text, mediaUrls } = await resolveContent(input);
      const brand = getBrandOrThrow(brandKey);
      const provider = getProvider();

      const results = [];
      for (const platform of input.platforms) {
        const account = resolveAccount(brand, platform);
        const platformOptions = buildPlatformOptions(platform, input.tiktokOptions);
        const result = await provider.publishPost({
          target: { platform, accountId: account.accountId, pageId: account.pageId, boardId: account.boardId },
          content: { text, mediaUrls, platformOptions }
        });
        results.push({ platform, ...result });
      }
      return { content: [{ type: "text", text: JSON.stringify({ brand: brandKey, results }, null, 2) }] };
    }
  );

  // ---------------------------------------------------------------------------
  // schedulePost
  // ---------------------------------------------------------------------------
  server.registerTool(
    "schedulePost",
    {
      description:
        "Schedule a post for a brand to one or more platforms at a specific date/time, or at the brand's next open calendar slot.",
      inputSchema: {
        ...InlineOrDraftShape,
        platforms: z.array(PlatformSchema).min(1),
        date: z.string().optional().describe("YYYY-MM-DD. Required unless useNextFreeSlot is true."),
        time: z.string().optional().describe("HH:MM in 24-hour format. Required unless useNextFreeSlot is true."),
        timezoneOffset: z
          .string()
          .default("Z")
          .describe('UTC offset applied to date/time, e.g. "-04:00" for US Eastern Daylight Time. Default "Z" (UTC).'),
        useNextFreeSlot: z
          .boolean()
          .optional()
          .describe("Schedule to the next open calendar slot instead of an exact date/time."),
        tiktokOptions: TikTokOptionsSchema
      },
      _meta: { "openai/fileParams": ["image"] }
    },
    async (input) => {
      const { brand: brandKey, text, mediaUrls } = await resolveContent(input);
      const brand = getBrandOrThrow(brandKey);
      const provider = getProvider();

      let scheduledTime: string | undefined;
      if (!input.useNextFreeSlot) {
        if (!input.date || !input.time) {
          throw new Error("Provide date + time, or set useNextFreeSlot: true.");
        }
        scheduledTime = `${input.date}T${input.time}:00${input.timezoneOffset}`;
      }

      const results = [];
      for (const platform of input.platforms) {
        const account = resolveAccount(brand, platform);
        const platformOptions = buildPlatformOptions(platform, input.tiktokOptions);
        const result = await provider.schedulePost({
          target: { platform, accountId: account.accountId, pageId: account.pageId, boardId: account.boardId },
          content: { text, mediaUrls, platformOptions },
          scheduledTime,
          useNextFreeSlot: input.useNextFreeSlot
        });
        results.push({ platform, ...result });
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { brand: brandKey, scheduledTime: scheduledTime ?? "next-free-slot", results },
              null,
              2
            )
          }
        ]
      };
    }
  );

  // ---------------------------------------------------------------------------
  // editScheduledPost
  // ---------------------------------------------------------------------------
  server.registerTool(
    "editScheduledPost",
    {
      description:
        "Edit an existing scheduled post's caption, hashtags, image, and/or time. Only the fields you pass are changed — everything else is left as-is.",
      inputSchema: {
        scheduleId: z.string(),
        caption: z.string().optional(),
        hashtags: z.array(z.string()).optional(),
        image: ImageInputSchema.describe(
          "A public image URL, or an image the user uploaded/ChatGPT generated in this conversation."
        ),
        date: z.string().optional().describe("YYYY-MM-DD. Provide together with time to reschedule."),
        time: z.string().optional().describe("HH:MM 24-hour. Provide together with date to reschedule."),
        timezoneOffset: z.string().default("Z")
      },
      _meta: { "openai/fileParams": ["image"] }
    },
    async ({ scheduleId, caption, hashtags, image, date, time, timezoneOffset }) => {
      const text = caption !== undefined ? composeCaption(caption, hashtags) : undefined;
      const mediaUrls = image !== undefined ? await resolveImageUrl(image, getProvider()) : undefined;
      const scheduledTime = date && time ? `${date}T${time}:00${timezoneOffset}` : undefined;

      await getProvider().editScheduledPost({ scheduleId, text, mediaUrls, scheduledTime });
      return { content: [{ type: "text", text: `Updated schedule ${scheduleId}.` }] };
    }
  );

  // ---------------------------------------------------------------------------
  // deleteScheduledPost
  // ---------------------------------------------------------------------------
  server.tool(
    "deleteScheduledPost",
    "Cancel and delete a scheduled post.",
    { scheduleId: z.string() },
    async ({ scheduleId }) => {
      await getProvider().deleteScheduledPost(scheduleId);
      return { content: [{ type: "text", text: `Deleted schedule ${scheduleId}.` }] };
    }
  );

  // ---------------------------------------------------------------------------
  // listScheduledPosts
  // ---------------------------------------------------------------------------
  server.tool(
    "listScheduledPosts",
    "List upcoming scheduled posts, optionally filtered by brand and/or platform.",
    {
      brand: BrandKeySchema.optional(),
      platform: PlatformSchema.optional(),
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().optional()
    },
    async ({ brand, platform, limit, cursor }) => {
      const { items, cursor: nextCursor } = await getProvider().listScheduledPosts({ limit, cursor });

      let filtered = items;
      if (platform) filtered = filtered.filter((i) => i.platform === platform);
      if (brand) {
        const b = getBrandOrThrow(brand);
        const accountIds = new Set(Object.values(b.accounts).map((a) => a?.accountId));
        const pageIds = new Set(
          Object.values(b.accounts)
            .map((a) => a?.pageId)
            .filter(Boolean)
        );
        filtered = filtered.filter((i) => accountIds.has(i.accountId) || (i.pageId && pageIds.has(i.pageId)));
      }

      return { content: [{ type: "text", text: JSON.stringify({ items: filtered, cursor: nextCursor }, null, 2) }] };
    }
  );

  // ---------------------------------------------------------------------------
  // getAnalytics
  // ---------------------------------------------------------------------------
  server.tool(
    "getAnalytics",
    "Get reach, impressions, likes, shares, comments, and clicks for published posts. Pass postId for one specific post, or filter by platform/date range for top performers. Note: the underlying analytics API filters by platform, not by brand/account — when brand is given, cross-check the returned postUrl to confirm it belongs to that brand.",
    {
      postId: z.string().optional(),
      brand: BrandKeySchema.optional(),
      platform: PlatformSchema.optional(),
      since: z.string().optional().describe("ISO 8601 timestamp. Defaults to 30 days ago."),
      until: z.string().optional().describe("ISO 8601 timestamp. Defaults to now."),
      limit: z.number().int().min(1).max(100).optional(),
      sortBy: z.enum(["likes_count", "comments_count", "views_count", "reach_count"]).optional()
    },
    async ({ postId, brand, platform, since, until, limit, sortBy }) => {
      if (brand) getBrandOrThrow(brand);
      const items = await getProvider().getAnalytics({ postId, platform, since, until, limit, sortBy });
      return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
    }
  );

  return server;
}
