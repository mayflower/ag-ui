# @mayflowergmbh/ag-ui-mcp-apps-middleware

MCP Apps middleware for AG-UI that enables UI-enabled tools from MCP (Model Context Protocol) servers.

## Installation

```bash
npm install @mayflowergmbh/ag-ui-mcp-apps-middleware
# or
pnpm add @mayflowergmbh/ag-ui-mcp-apps-middleware
```

If you want to preserve an existing `@ag-ui/mcp-apps-middleware` import path in a
consumer app, install it via an npm alias:

```bash
pnpm add @ag-ui/mcp-apps-middleware@npm:@mayflowergmbh/ag-ui-mcp-apps-middleware
```

## Usage

```typescript
import { MCPAppsMiddleware } from "@mayflowergmbh/ag-ui-mcp-apps-middleware";

const agent = new YourAgent().use(
  new MCPAppsMiddleware({
    mcpServers: [
      {
        type: "http",
        url: "http://localhost:3001/mcp",
        serverId: "weather-server",
        headers: { Authorization: "Bearer ..." },
      },
    ],
  }),
);
```

## Features

- Discovers UI-enabled tools from MCP servers
- Supports the preferred nested MCP Apps metadata shape (`_meta.ui.resourceUri`)
- Keeps deprecated flat metadata (`_meta["ui/resourceUri"]`) working for compatibility
- Advertises both canonical and legacy MCP Apps HTML MIME types
- Injects tools into the agent's tool list
- Prefers result-scoped `structuredContent.resourceUri` values when a tool returns one
- Executes pending UI tool calls in parallel and reuses one MCP client per server for the batch
- Forwards MCP `notifications/progress` to AG-UI as incremental `ACTIVITY_SNAPSHOT` events
- Supports proxied MCP requests for frontend resource fetching (`tools/call`, `tools/list`, `resources/read`, `resources/list`, `resources/templates/list`, `prompts/list`, `prompts/get`, `notifications/message`, `ping`)
- Warns on tool name collisions across configured MCP servers

## Configuration

```typescript
interface MCPAppsMiddlewareConfig {
  mcpServers?: MCPClientConfig[];
}

type MCPClientConfig =
  | {
      type: "http";
      url: string;
      headers?: Record<string, string>;
      serverId?: string;
      /** Skip the final ACTIVITY_SNAPSHOT emit. Default: true. */
      emitActivity?: boolean;
    }
  | {
      type: "sse";
      url: string;
      headers?: Record<string, string>;
      serverId?: string;
      emitActivity?: boolean;
    };
```

### `emitActivity`

Set `emitActivity: false` for a server when the frontend renders the widget directly from the tool-call args (e.g. via a dedicated tool-call renderer). The middleware will still execute the tool call and emit `TOOL_CALL_RESULT`, but skip the final `ACTIVITY_SNAPSHOT` so the widget is not double-mounted.

### Tool name collisions

If two configured servers expose a tool with the same name, the last one loaded wins. The middleware warns through `console.warn` with both server hashes and IDs so the host can disambiguate. To avoid collisions, set distinct `serverId`s and either expose unique tool names server-side or namespace your tools.

### Tool Metadata

MCP Apps tools are discovered through tool metadata that links a tool to a predeclared `ui://` resource.

Preferred metadata shape:

```typescript
_meta: {
  ui: {
    resourceUri: "ui://weather/forecast";
  }
}
```

Deprecated but still supported for compatibility:

```typescript
_meta: {
  "ui/resourceUri": "ui://weather/forecast"
}
```

If both are present, the nested `_meta.ui.resourceUri` value takes precedence.

### MIME Types

The middleware advertises support for both:

- Canonical MCP Apps MIME type: `text/html;profile=mcp-app`
- Legacy compatibility MIME type: `text/html+mcp`

### Server ID

The optional `serverId` field provides a stable identifier for the server. This is useful when:

- Server URLs may change (e.g., different environments)
- You want human-readable server identification
- Frontend code needs to reference servers by name

If `serverId` is not provided, the server is identified by an MD5 hash of its configuration.

## Activity Snapshot

The middleware emits activity snapshots with the following structure:

```typescript
{
  type: "ACTIVITY_SNAPSHOT",
  activityType: "mcp-apps",
  content: {
    result: MCPToolCallResult,     // Result from the tool execution
    resourceUri: string,           // URI of the UI resource to fetch
    serverHash: string,            // MD5 hash of server config
    serverId?: string,             // Server ID (if configured)
    toolInput: Record<string, unknown>  // Arguments passed to the tool
  },
  replace: true
}
```

The frontend should fetch the resource content via proxied MCP request using `resourceUri` and either `serverHash` or `serverId`.

`resourceUri` resolution order is:

1. `result.structuredContent.resourceUri` when the tool returns a valid `ui://` URI
2. the tool-linked metadata resource URI from `_meta.ui.resourceUri` or `_meta["ui/resourceUri"]`

This lets tools point the activity snapshot at a concrete UI instance while preserving the metadata-linked resource as the default fallback.

## Streaming Progress

While a UI tool call is executing, the middleware forwards MCP [`notifications/progress`](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress) to the frontend using AG-UI's canonical streaming pattern: **one `ACTIVITY_SNAPSHOT` per tool call followed by `ACTIVITY_DELTA` events** carrying RFC 6902 JSON Patches. The snapshot's `messageId` is stable per tool call (`mcp-apps-progress:<toolCallId>`), so the AG-UI default apply path produces a single live-updating activity message even with multiple concurrent tool calls.

**On the first progress tick:**

```typescript
{
  type: "ACTIVITY_SNAPSHOT",
  messageId: `mcp-apps-progress:${toolCallId}`,
  activityType: "mcp-apps-progress",
  content: {
    progress: number,            // Per MCP spec, monotonically increasing
    total?: number,              // Only present if the MCP server provided it
    message?: string,            // Human-readable progress (per MCP spec)
    toolCallId: string,
    toolName: string,
    serverHash: string,
    serverId?: string
  },
  replace: false                 // Idempotent: re-emits are dropped by the apply path
}
```

**On every subsequent tick:**

```typescript
{
  type: "ACTIVITY_DELTA",
  messageId: `mcp-apps-progress:${toolCallId}`,
  activityType: "mcp-apps-progress",
  patch: [
    { op: "replace", path: "/progress", value: 0.75 },
    { op: "add",     path: "/message",  value: "almost done" },  // example
    // ...only changed fields are included
  ]
}
```

The middleware uses `add` / `remove` ops when an optional `total` or `message` field appears or disappears across ticks, and `replace` for value changes on existing fields. The stable `toolCallId`, `toolName`, `serverHash`, and `serverId` are not re-emitted on deltas.

Import the constant on the consumer side to filter for these events:

```typescript
import { MCPAppsProgressActivityType } from "@mayflowergmbh/ag-ui-mcp-apps-middleware";
```

A final `mcp-apps` snapshot (with `replace: true`, on a different `messageId`) is emitted after the tool call completes, unless the server was configured with `emitActivity: false`.

> **`mcp-apps-progress` is a middleware-private extension.** It is **not** part of [SEP-1865](https://modelcontextprotocol.io/community/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp) and is **not** consumed by CopilotKit's stock `MCPAppsActivityRenderer`. Hosts that want to surface a progress indicator must render the `mcp-apps-progress` activity type themselves.

## Performance and Concurrency

- Pending UI tool calls are executed in parallel via `Promise.all`. Independent RPCs no longer block on each other.
- A run-scoped MCP client cache reuses a single client per server across all of that run's tool calls — one connect/close per (server, run) instead of one per call.
- Tool discovery (`fetchUITools`) queries all configured servers in parallel; a failure on one server is logged through `console.error` but does not block the others.

## Proxied MCP Requests

The middleware supports proxied MCP requests from the frontend. Pass a `ProxiedMCPRequest` in `forwardedProps.__proxiedMCPRequest`:

```typescript
interface ProxiedMCPRequest {
  serverHash: string; // MD5 hash of server config
  serverId?: string; // Optional server ID for lookup
  method: string; // MCP method (e.g., "resources/read", "tools/call")
  params?: Record<string, unknown>;
}
```

Server lookup prefers `serverId` if provided, falling back to `serverHash`.

## Exported Utilities

```typescript
import {
  MCPAppsMiddleware, // The middleware class
  MCPAppsActivityType, // "mcp-apps" constant for the final widget snapshot
  MCPAppsProgressActivityType, // "mcp-apps-progress" constant for streaming progress events
  getServerHash, // Generate server hash from config
  type MCPAppsMiddlewareConfig,
  type MCPClientConfig,
  type MCPClientConfigHTTP,
  type MCPClientConfigSSE,
  type ProxiedMCPRequest,
} from "@mayflowergmbh/ag-ui-mcp-apps-middleware";
```

## License

MIT
