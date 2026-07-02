// In-memory draft store backing createPost(). Blotato (and most providers)
// have no persisted "draft" concept — a post is either published or
// scheduled. So createPost composes and validates the content here and
// hands back a draftId that publishPost/schedulePost can reuse. Drafts live
// only for the current server process; they are not written to disk.

import { randomUUID } from "node:crypto";

export interface Draft {
  draftId: string;
  brand: string;
  text: string;
  mediaUrls: string[];
  createdAt: string;
}

const drafts = new Map<string, Draft>();

export function createDraft(brand: string, text: string, mediaUrls: string[]): Draft {
  const draft: Draft = {
    draftId: randomUUID(),
    brand,
    text,
    mediaUrls,
    createdAt: new Date().toISOString()
  };
  drafts.set(draft.draftId, draft);
  return draft;
}

export function getDraft(draftId: string): Draft {
  const draft = drafts.get(draftId);
  if (!draft) {
    throw new Error(
      `No draft found with id "${draftId}". Drafts only live for the current server session — ` +
        `call createPost again if the server restarted.`
    );
  }
  return draft;
}

export function composeCaption(caption: string, hashtags?: string[]): string {
  if (!hashtags || hashtags.length === 0) return caption;
  const tags = hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
  return `${caption}\n\n${tags}`;
}
