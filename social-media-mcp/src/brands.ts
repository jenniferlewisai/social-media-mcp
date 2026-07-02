// Brand registry. Adding a brand is a config-only change: add an entry
// below with its real Facebook/Instagram/TikTok ids, set enabled: true,
// and it is immediately usable from every MCP tool. No code changes
// anywhere else in the project are required.

import type { Platform } from "./providers/types.js";

export interface PlatformAccount {
  /** Provider connected-account id (e.g. Blotato accountId). */
  accountId: string;
  /** Facebook Page ID / LinkedIn Company Page ID. */
  pageId?: string;
  /** Pinterest board id. */
  boardId?: string;
}

export interface BrandConfig {
  key: string;
  displayName: string;
  voice: string[];
  website?: string;
  logoPath?: string;
  /** false = placeholder for a future brand; not yet connected to any platform. */
  enabled: boolean;
  accounts: Partial<Record<Platform, PlatformAccount>>;
}

// Blotato's connected Facebook LOGIN account id — this is the account that
// administers all of your brands' Facebook Pages. One login can manage
// multiple Pages, so this id is shared across brands; only the pageId below
// changes per brand. Confirmed value: 39452. Still overridable via env var
// in case the connection is ever regenerated with a new id.
const SHARED_FACEBOOK_ACCOUNT_ID = process.env.BLOTATO_FACEBOOK_ACCOUNT_ID ?? "39452";

export const BRANDS: Record<string, BrandConfig> = {
  jennifer_personal: {
    key: "jennifer_personal",
    displayName: "Jennifer's Personal Page",
    voice: [], // TODO: add brand voice bullets for Jennifer's personal brand
    website: undefined, // TODO: add website URL
    logoPath: undefined, // TODO: add path/URL to brand logo
    enabled: true,
    accounts: {
      // No pageId given — Blotato requires target.pageId for every Facebook
      // post. If this is a Facebook Page (not a personal profile), get its
      // Page ID from listConnectedAccounts/subaccounts and add it here;
      // until then, publishPost/schedulePost to "facebook" for this brand
      // will fail with a clear "missing pageId" error from Blotato.
      facebook: { accountId: "39452" },
      instagram: { accountId: "56564" },
      tiktok: { accountId: "49189" }
    }
  },

  the_boarding_group: {
    key: "the_boarding_group",
    displayName: "The Boarding Group",
    voice: [
      "Luxury travel",
      "Black / Gold",
      "Premium",
      "Group travel",
      "Sports travel",
      "Cruises",
      "International trips"
    ],
    website: undefined, // TODO: add website URL
    logoPath: undefined, // TODO: add path/URL to brand logo
    enabled: true,
    accounts: {
      facebook: { accountId: SHARED_FACEBOOK_ACCOUNT_ID, pageId: "152921371230446" },
      instagram: { accountId: "56573" }
    }
  },

  safeguard_financial: {
    key: "safeguard_financial",
    displayName: "Safeguard Financial",
    voice: ["Professional", "Educational", "Tax", "Insurance", "Compliance"],
    website: undefined, // TODO: add website URL
    logoPath: undefined, // TODO: add path/URL to brand logo
    enabled: true,
    accounts: {
      facebook: { accountId: SHARED_FACEBOOK_ACCOUNT_ID, pageId: "272592279534378" },
      instagram: { accountId: "56576" }
    }
  },

  focused_photobooths: {
    key: "focused_photobooths",
    displayName: "Focused Photobooths",
    voice: ["Fun", "Weddings", "Events", "Corporate", "Birthday Parties"],
    website: undefined, // TODO: add website URL
    logoPath: undefined, // TODO: add path/URL to brand logo
    enabled: true,
    accounts: {
      facebook: { accountId: SHARED_FACEBOOK_ACCOUNT_ID, pageId: "331182600072547" },
      instagram: { accountId: "56566" }
    }
  },

  // ---------------------------------------------------------------------
  // FUTURE BRANDS — placeholders only. Fill in real Facebook Page ID /
  // Instagram Account ID / TikTok Account ID / brand voice, flip
  // enabled: true, and the brand is live in every tool. Nothing else to
  // change.
  // ---------------------------------------------------------------------
  atlas_ai: { key: "atlas_ai", displayName: "Atlas AI", voice: [], enabled: false, accounts: {} },
  tax_compliance_pro: {
    key: "tax_compliance_pro",
    displayName: "Tax Compliance Pro",
    voice: [],
    enabled: false,
    accounts: {}
  },
  payoutpro: { key: "payoutpro", displayName: "PayoutPro", voice: [], enabled: false, accounts: {} },
  chilling_with_friends: {
    key: "chilling_with_friends",
    displayName: "Chilling With Friends",
    voice: [],
    enabled: false,
    // A Facebook Page for this brand is already connected in Blotato (confirmed
    // via the Connected Accounts screen) under the shared login accountId
    // above. It only needs its pageId — run listConnectedAccounts with
    // accountId: "39452" to get it, paste it below, and set enabled: true.
    accounts: {}
  },
  fleet_three_eighty_five: {
    key: "fleet_three_eighty_five",
    displayName: "Fleet Three Eighty Five",
    voice: [],
    enabled: false,
    accounts: {}
  },
  stay_n_tha_game: {
    key: "stay_n_tha_game",
    displayName: "Stay N Tha Game",
    voice: [],
    enabled: false,
    accounts: {}
  },
  // NOTE: the connected accounts screen shows this Facebook Page as
  // "Say It Threads" rather than "St8ment Threads" — displayName updated to
  // match what's actually connected in Blotato. Flag if that's a different
  // brand than intended.
  say_it_threads: {
    key: "say_it_threads",
    displayName: "Say It Threads",
    voice: [],
    enabled: false,
    // Facebook Page already connected in Blotato under the shared login
    // accountId above — same as chilling_with_friends, just needs its pageId.
    accounts: {}
  }
};

export type BrandKey = keyof typeof BRANDS;

export const BRAND_KEYS = Object.keys(BRANDS) as [string, ...string[]];

export function getBrandOrThrow(key: string): BrandConfig {
  const brand = BRANDS[key];
  if (!brand) {
    throw new Error(`Unknown brand "${key}". Known brands: ${Object.keys(BRANDS).join(", ")}`);
  }
  if (!brand.enabled) {
    throw new Error(
      `Brand "${key}" is not configured yet (no connected social accounts). ` +
        `Add its Facebook/Instagram/TikTok ids in src/brands.ts and set enabled: true.`
    );
  }
  return brand;
}

export function resolveAccount(brand: BrandConfig, platform: Platform): PlatformAccount {
  const account = brand.accounts[platform];
  if (!account) {
    const configured = Object.keys(brand.accounts).join(", ") || "none";
    throw new Error(`${brand.displayName} is not configured for ${platform}. Configured platforms: ${configured}.`);
  }
  return account;
}
