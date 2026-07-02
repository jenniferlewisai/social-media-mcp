// Provider registry / factory. This is the ONLY place that decides which
// provider implementation backs the SocialProvider interface. To add a new
// provider (Buffer, Metricool, Hootsuite, Meta directly, etc.):
//   1. Create src/providers/<name>.ts implementing SocialProvider.
//   2. Add a case below.
//   3. Set SOCIAL_PROVIDER=<name> in the environment.
// No changes to src/index.ts (the MCP tools) are ever required.

import type { SocialProvider } from "./types.js";
import { BlotatoProvider } from "./blotato.js";

const PROVIDER_NAME = (process.env.SOCIAL_PROVIDER ?? "blotato").toLowerCase();

let cached: SocialProvider | undefined;

export function getProvider(): SocialProvider {
  if (cached) return cached;

  switch (PROVIDER_NAME) {
    case "blotato":
      cached = new BlotatoProvider();
      break;
    // case "buffer":
    //   cached = new BufferProvider();
    //   break;
    // case "metricool":
    //   cached = new MetricoolProvider();
    //   break;
    default:
      throw new Error(`Unknown SOCIAL_PROVIDER "${PROVIDER_NAME}". Supported providers: blotato.`);
  }
  return cached;
}

export * from "./types.js";
