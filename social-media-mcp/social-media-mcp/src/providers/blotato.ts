// Blotato implementation of the generic SocialProvider interface.
// This is the ONLY file that knows about Blotato's REST API shape
// (backend.blotato.com/v2, blotato-api-key header, /posts, /schedules,
// /analytics endpoints). Everything else in this project talks to the
// SocialProvider interface, not to Blotato directly.
//
// Endpoint reference: https://help.blotato.com/api/llm.md

import type {
  AnalyticsItem,
  AnalyticsQuery,
  EditScheduledInput,
  Platform,
  PublishInput,
  ScheduledPostSummary,
  ScheduleInput,
  SocialProvider,
  SubmitResult
} from "./types.js";

const BASE_URL = "https://backend.blotato.com/v2";

function requireApiKey(): string {
  const key = process.env.BLOTATO_API_KEY;
  if (!key) {
    throw new Error(
      "Missing BLOTATO_API_KEY environment variable. Set it in your MCP client config or .env file " +
        "(see .env.example). Never hardcode the key in source."
    );
  }
  return key;
}

async function blotatoRequest(path: string, init: RequestInit = {}): Promise<any> {
  const apiKey = requireApiKey();
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "blotato-api-key": apiKey,
      ...(init.headers ?? {})
    }
  });

  const raw = await response.text();
  let data: any = raw;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    // Non-JSON response body (e.g. plain error text) — leave as raw string.
  }

  if (!response.ok) {
    const message = typeof data === "object" ? JSON.stringify(data) : String(data);
    throw new Error(`Blotato API error ${response.status} on ${init.method ?? "GET"} ${path}: ${message}`);
  }
  return data;
}

function numOrUndef(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

function toPostPayload(input: { target: PublishInput["target"]; content: PublishInput["content"] }) {
  const { target, content } = input;
  return {
    accountId: target.accountId,
    content: {
      text: content.text,
      mediaUrls: content.mediaUrls ?? [],
      platform: target.platform
    },
    target: {
      targetType: target.platform,
      ...(target.pageId ? { pageId: target.pageId } : {}),
      ...(target.boardId ? { boardId: target.boardId } : {}),
      ...(content.platformOptions ?? {})
    }
  };
}

export class BlotatoProvider implements SocialProvider {
  readonly name = "blotato";

  async listConnectedAccounts(platform?: Platform) {
    const qs = platform ? `?platform=${encodeURIComponent(platform)}` : "";
    return blotatoRequest(`/users/me/accounts${qs}`, { method: "GET" });
  }

  async listSubaccounts(accountId: string) {
    return blotatoRequest(`/users/me/accounts/${accountId}/subaccounts`, { method: "GET" });
  }

  async uploadMediaFromBytes(bytes: Uint8Array, filename: string, contentType: string): Promise<string> {
    // Step 1: ask Blotato for a presigned upload URL for this filename.
    const { presignedUrl, publicUrl } = await blotatoRequest("/media/uploads", {
      method: "POST",
      body: JSON.stringify({ filename })
    });
    if (!presignedUrl || !publicUrl) {
      throw new Error("Blotato did not return a presignedUrl/publicUrl from POST /media/uploads.");
    }

    // Step 2: PUT the raw bytes directly to that presigned URL. This is NOT
    // a Blotato API call (no blotato-api-key header, no JSON body) — it's a
    // direct upload to Blotato's storage backend per their presigned-upload
    // contract.
    const putResponse = await fetch(presignedUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: bytes as BodyInit
    });
    if (!putResponse.ok) {
      const text = await putResponse.text().catch(() => "");
      throw new Error(`Failed to upload media to Blotato's presigned URL (status ${putResponse.status}): ${text}`);
    }

    // Step 3: publicUrl is now a real, publicly fetchable URL — safe to use
    // in mediaUrls on a publish/schedule call.
    return publicUrl;
  }

  async publishPost(input: PublishInput): Promise<SubmitResult> {
    const payload = { post: toPostPayload(input) };
    const data = await blotatoRequest("/posts", { method: "POST", body: JSON.stringify(payload) });
    return { submissionId: data.postSubmissionId ?? "", raw: data };
  }

  async schedulePost(input: ScheduleInput): Promise<SubmitResult> {
    const payload: Record<string, unknown> = { post: toPostPayload(input) };
    // scheduledTime / useNextFreeSlot MUST be root-level siblings of "post" —
    // nesting them inside "post" silently causes Blotato to publish immediately.
    if (input.scheduledTime) {
      payload.scheduledTime = input.scheduledTime;
    } else if (input.useNextFreeSlot) {
      payload.useNextFreeSlot = true;
    } else {
      throw new Error("schedulePost requires either scheduledTime or useNextFreeSlot.");
    }
    const data = await blotatoRequest("/posts", { method: "POST", body: JSON.stringify(payload) });
    return { submissionId: data.postSubmissionId ?? "", raw: data };
  }

  private toSummary(item: any): ScheduledPostSummary {
    return {
      scheduleId: item.id,
      scheduledAt: item.scheduledAt,
      platform: item.draft?.content?.platform ?? "unknown",
      accountId: item.draft?.accountId ?? item.account?.id ?? "",
      pageId: item.draft?.target?.pageId,
      text: item.draft?.content?.text ?? "",
      mediaUrls: item.draft?.content?.mediaUrls ?? [],
      raw: item
    };
  }

  async listScheduledPosts(opts: { limit?: number; cursor?: string }) {
    const params = new URLSearchParams();
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.cursor) params.set("cursor", opts.cursor);
    const qs = params.toString() ? `?${params.toString()}` : "";
    const data = await blotatoRequest(`/schedules${qs}`, { method: "GET" });
    const items: ScheduledPostSummary[] = (data.items ?? []).map((item: any) => this.toSummary(item));
    return { items, cursor: data.cursor };
  }

  async getScheduledPost(scheduleId: string): Promise<ScheduledPostSummary> {
    const data = await blotatoRequest(`/schedules/${scheduleId}`, { method: "GET" });
    return this.toSummary(data.schedule ?? data);
  }

  async editScheduledPost(input: EditScheduledInput): Promise<void> {
    // Blotato's PATCH does NOT merge partial drafts: you must send the whole
    // draft object back. Fetch the current schedule first and only override
    // the fields the caller actually asked to change.
    const current = await this.getScheduledPost(input.scheduleId);

    const platform = input.platform ?? (current.platform as Platform);
    const pageId = input.pageId ?? current.pageId;

    const patch: Record<string, unknown> = {
      draft: {
        accountId: input.accountId ?? current.accountId,
        content: {
          text: input.text ?? current.text,
          mediaUrls: input.mediaUrls ?? current.mediaUrls,
          platform
        },
        target: {
          targetType: platform,
          ...(pageId ? { pageId } : {})
        }
      }
    };
    if (input.scheduledTime) {
      patch.scheduledTime = input.scheduledTime;
    }

    await blotatoRequest(`/schedules/${input.scheduleId}`, {
      method: "PATCH",
      body: JSON.stringify({ patch })
    });
  }

  async deleteScheduledPost(scheduleId: string): Promise<void> {
    await blotatoRequest(`/schedules/${scheduleId}`, { method: "DELETE" });
  }

  async getAnalytics(query: AnalyticsQuery): Promise<AnalyticsItem[]> {
    if (query.postId) {
      const data = await blotatoRequest(`/posts/${query.postId}/analytics`, { method: "GET" });
      const m = data.metrics ?? {};
      return [
        {
          postId: data.publishedPostId,
          platform: data.platform,
          reach: numOrUndef(m.reachCount),
          impressions: numOrUndef(m.impressionsCount),
          likes: numOrUndef(m.likesCount),
          shares: numOrUndef(m.sharesCount),
          comments: numOrUndef(m.commentsCount),
          clicks: numOrUndef(m.clicksCount),
          raw: data
        }
      ];
    }

    const params = new URLSearchParams();
    if (query.since) params.set("since", query.since);
    if (query.until) params.set("until", query.until);
    if (query.platform) params.set("platform", query.platform);
    if (query.sortBy) params.set("sortBy", query.sortBy);
    if (query.limit) params.set("limit", String(query.limit));
    const qs = params.toString() ? `?${params.toString()}` : "";
    const data = await blotatoRequest(`/analytics${qs}`, { method: "GET" });

    return (data.items ?? []).map((item: any) => {
      const m = item.latestMetrics?.metrics ?? {};
      return {
        postId: item.id,
        platform: item.platform,
        postUrl: item.postUrl,
        createdAt: item.createdAt,
        text: item.content,
        reach: numOrUndef(m.reachCount),
        impressions: numOrUndef(m.impressionsCount),
        likes: numOrUndef(m.likesCount),
        shares: numOrUndef(m.sharesCount),
        comments: numOrUndef(m.commentsCount),
        clicks: numOrUndef(m.clicksCount),
        raw: item
      };
    });
  }
}
