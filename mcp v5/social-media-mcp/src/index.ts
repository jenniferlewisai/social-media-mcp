// stdio entrypoint — used by local MCP clients that spawn a subprocess
// (Claude Desktop, Claude Code, Cursor, etc.). For ChatGPT, which needs a
// remote HTTPS endpoint instead, run src/http.ts.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
