// Remote HTTP entrypoint — this is what ChatGPT connects to.
//
// ChatGPT (and other remote MCP clients) cannot spawn a local subprocess the
// way Claude Desktop/Cursor do with stdio. They require an MCP server
// reachable over HTTPS speaking the Streamable HTTP transport, at a URL like
// https://your-host/mcp. This file exposes exactly that using Express + the
// SDK's StreamableHTTPServerTransport, following the official session
// pattern: one McpServer + one transport per client session, tracked by the
// Mcp-Session-Id header.
//
// Deployment: run this behind HTTPS (Render/Railway/Fly/your own box + a
// reverse proxy). See README.md for a concrete Render walkthrough.

import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server.js";

const AUTH_TOKEN = process.env.MCP_HTTP_AUTH_TOKEN;

if (!AUTH_TOKEN) {
  console.error(
    "WARNING: MCP_HTTP_AUTH_TOKEN is not set. This HTTP endpoint will accept requests from " +
      "anyone who finds the URL, with no authentication. Set MCP_HTTP_AUTH_TOKEN before exposing " +
      "this publicly — ChatGPT's connector setup lets you paste a static API token for exactly this."
  );
}

function isAuthorized(req: Request): boolean {
  if (!AUTH_TOKEN) return true; // no token configured — see warning above
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${AUTH_TOKEN}`;
}

const app = express();
app.use(express.json());

// Health check for hosting platforms (Render/Railway/etc. ping this to
// confirm the service is up).
app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// One transport (and one McpServer) per client session, keyed by the
// Mcp-Session-Id header the SDK assigns during initialization.
const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", async (req: Request, res: Response) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      }
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    const mcpServer = createServer();
    await mcpServer.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: missing or invalid Mcp-Session-Id" },
      id: null
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

async function handleSessionRequest(req: Request, res: Response) {
  if (!isAuthorized(req)) {
    res.status(401).send("Unauthorized");
    return;
  }
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing Mcp-Session-Id");
    return;
  }
  await transport.handleRequest(req, res);
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.error(`Social Media MCP HTTP server listening on port ${port} (POST/GET/DELETE /mcp, GET /healthz)`);
});
