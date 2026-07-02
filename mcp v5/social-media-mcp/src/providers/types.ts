// Generic publishing-provider contract. Every social provider (Blotato today;
// Buffer / Metricool / Hootsuite / Meta later) implements this same interface.
// MCP tools in src/index.ts only ever talk to this interface — they never
// import a provider-specific module directly. That is what makes the
// provider swappable via SOCIAL_PROVIDER without touching tool code.

export const PLATFORMS = [
  "facebook",
  "instagram",
  "tiktok",
  "twitter",
  "linkedin",
  "youtube",
  "threads",
  "bluesky",
  "pinterest"
] as const;

export type Platform = (typeof PLATFORMS)[number];

export interface PostContent {
  text: string;
  mediaUrls: string[];
  /** Escape hatch for platform-specific fields (e.g. TikTok privacy flags, IG reel options). */
  platformOptions?: Record<string, unknown>;
}

export interface PublishTarget {
  platform: Platform;
  /** Provider-specific connected-account id. */
  accountId: string;
  /** Required by some providers for Facebook/LinkedIn Page targeting. */
  pageId?: string;
  /** Required by some providers for Pinterest board targeting. */
  boardId?: string;
}

export interface PublishInput {
  target: PublishTarget;
  content: PostContent;
}

export interface ScheduleInput extends PublishInput {
  /** ISO 8601 timestamp with offset. Omit and set useNextFreeSlot instead to auto-pick a slot. */
  scheduledTime?: string;
  useNextFreeSlot?: boolean;
}

export interface SubmitResult {
  submissionId: string;
  raw: unknown;
}

export interface ScheduledPostSummary {
  scheduleId: string;
  scheduledAt: string;
  platform: string;
  accountId: string;
  pageId?: string;
  text: string;
  mediaUrls: string[];
  raw: unknown;
}

export interface EditScheduledInput {
  scheduleId: string;
  text?: string;
  mediaUrls?: string[];
  platform?: Platform;
  accountId?: string;
  pageId?: string;
  scheduledTime?: string;
}

export interface AnalyticsQuery {
  postId?: string;
  platform?: Platform;
  since?: string;
  until?: string;
  limit?: number;
  sortBy?: "likes_count" | "comments_count" | "views_count" | "reach_count";
}

export interface AnalyticsItem {
  postId: string;
  platform: string;
  postUrl?: string | null;
  createdAt?: string;
  text?: string;
  reach?: number;
  impressions?: number;
  likes?: number;
  shares?: number;
  comments?: number;
  clicks?: number;
  raw: unknown;
}

export interface SocialProvider {
  readonly name: string;
  listConnectedAccounts(platform?: Platform): Promise<unknown>;
  listSubaccounts(accountId: string): Promise<unknown>;

  /**
   * Upload raw bytes (e.g. a file ChatGPT handed us via a temporary download
   * URL) to the provider's own media storage and return a publicly fetchable
   * URL. Needed because publish/schedule calls require a URL the provider's
   * servers can fetch themselves — a ChatGPT-issued temporary download URL
   * generally isn't reachable by a third-party server.
   */
  uploadMediaFromBytes(bytes: Uint8Array, filename: string, contentType: string): Promise<string>;
  publishPost(input: PublishInput): Promise<SubmitResult>;
  schedulePost(input: ScheduleInput): Promise<SubmitResult>;
  listScheduledPosts(opts: { limit?: number; cursor?: string }): Promise<{
    items: ScheduledPostSummary[];
    cursor?: string;
  }>;
  getScheduledPost(scheduleId: string): Promise<ScheduledPostSummary>;
  editScheduledPost(input: EditScheduledInput): Promise<void>;
  deleteScheduledPost(scheduleId: string): Promise<void>;
  getAnalytics(query: AnalyticsQuery): Promise<AnalyticsItem[]>;
}
