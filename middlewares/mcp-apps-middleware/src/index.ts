import {
  Middleware,
  RunAgentInput,
  AbstractAgent,
  BaseEvent,
  Tool,
  EventType,
  Message,
  ToolCall,
  ToolCallResultEvent,
  ActivitySnapshotEvent,
  ActivityDeltaEvent,
  RunStartedEvent,
  RunFinishedEvent,
} from "@ag-ui/client";
import { Observable, from, switchMap } from "rxjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomUUID, createHash } from "crypto";

/**
 * Activity type for the final MCP Apps widget snapshot.
 */
export const MCPAppsActivityType = "mcp-apps";

/**
 * Activity type for in-flight progress events emitted while a UI tool call
 * is still executing.
 *
 * The middleware uses the AG-UI canonical streaming pattern: one
 * `ACTIVITY_SNAPSHOT` per tool call (with `replace: false`, keyed by a
 * stable `messageId` derived from `toolCallId`) followed by N
 * `ACTIVITY_DELTA` events carrying RFC 6902 JSON Patch updates. Consumers
 * that hook into the default AG-UI apply path will see one live-updating
 * activity message per concurrent tool call.
 *
 * **This activity type is a middleware-private extension.** It is not part
 * of SEP-1865 (MCP Apps) and is not consumed by CopilotKit's
 * `MCPAppsActivityRenderer` out of the box. Hosts that want a progress
 * indicator must render `mcp-apps-progress` themselves.
 */
export const MCPAppsProgressActivityType = "mcp-apps-progress";

/**
 * Build the stable AG-UI activity messageId for a given tool call's
 * progress stream. Stability lets the consumer apply the SNAPSHOT first
 * and then mutate the same activity message via subsequent DELTAs.
 */
function progressMessageIdFor(toolCallId: string): string {
  return `mcp-apps-progress:${toolCallId}`;
}

/**
 * Single MCP `notifications/progress` payload as exposed by the SDK's
 * `RequestOptions.onprogress` callback.
 */
interface ProgressTick {
  progress: number;
  total?: number;
  message?: string;
}

/**
 * Build a JSON Patch (RFC 6902) for the changing fields between two
 * progress ticks. `progress` is always present per spec; `total` and
 * `message` are optional, so we have to translate add/remove transitions
 * into the right ops.
 */
function buildProgressPatch(
  prev: ProgressTick,
  next: ProgressTick,
): Array<Record<string, unknown>> {
  const patch: Array<Record<string, unknown>> = [];
  if (prev.progress !== next.progress) {
    patch.push({ op: "replace", path: "/progress", value: next.progress });
  }
  patch.push(...patchOptional("/total", prev.total, next.total));
  patch.push(...patchOptional("/message", prev.message, next.message));
  return patch;
}

function patchOptional<T>(
  path: string,
  prev: T | undefined,
  next: T | undefined,
): Array<Record<string, unknown>> {
  if (prev === next) return [];
  if (prev === undefined) return [{ op: "add", path, value: next }];
  if (next === undefined) return [{ op: "remove", path }];
  return [{ op: "replace", path, value: next }];
}

/**
 * Pluggable logger surface. The middleware emits warnings on tool name
 * collisions and errors on transport / tool-execution failures. Hosts can
 * route these through their own logging stack instead of `console`.
 */
export interface Logger {
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (
    message: string,
    error?: unknown,
    context?: Record<string, unknown>,
  ) => void;
  info?: (message: string, context?: Record<string, unknown>) => void;
  debug?: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * Default logger that forwards to the global `console`. Arguments are only
 * forwarded when defined so existing tests asserting `console.error(msg, err)`
 * keep working without seeing trailing `undefined` slots.
 */
const consoleLogger: Logger = {
  warn: (message, context) => {
    if (context !== undefined) console.warn(message, context);
    else console.warn(message);
  },
  error: (message, error, context) => {
    if (context !== undefined) console.error(message, error, context);
    else if (error !== undefined) console.error(message, error);
    else console.error(message);
  },
};

/**
 * Proxied MCP request structure from the frontend iframe
 */
export interface ProxiedMCPRequest {
  /** Server hash (MD5 hash of config) */
  serverHash: string;
  /** Server name (optional, for lookup by name) */
  serverId?: string;
  /** The JSON-RPC method to call */
  method: string;
  /** The JSON-RPC params */
  params?: Record<string, unknown>;
}

/**
 * Extract EventWithState type from Middleware.runNextWithState return type
 */
type ExtractObservableType<T> = T extends Observable<infer U> ? U : never;
type RunNextWithStateReturn = ReturnType<Middleware["runNextWithState"]>;
export type EventWithState = ExtractObservableType<RunNextWithStateReturn>;

/**
 * UI Tool with its source server config and (optional) resource URI.
 *
 * `resourceUri` is omitted when the tool was injected from a server with
 * `includeToolsWithoutResource: true` and the tool itself has no
 * `_meta.ui.resourceUri`. In that mode the activity-snapshot emit is
 * suppressed because the snapshot has no `resourceUri` to advertise.
 */
interface UIToolInfo {
  tool: Tool;
  serverConfig: MCPClientConfig;
  resourceUri?: string;
}

/**
 * MCP Client configuration for HTTP transport
 */
export interface MCPClientConfigHTTP {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  serverId?: string;
  /**
   * Whether the middleware should emit an ACTIVITY_SNAPSHOT event after
   * executing this server's tool calls. Defaults to true (CopilotKit-compatible
   * behavior). Set to false when the frontend renders the widget directly from
   * the tool-call args (e.g. via a dedicated tool-call renderer) so a second
   * activity-snapshot driven surface does not double-mount the widget.
   */
  emitActivity?: boolean;
  /**
   * Treat this server as a general tool catalog source rather than a
   * SEP-1865 UI-only tool source. Defaults to false.
   *
   * When true, tools without `_meta.ui.resourceUri` are still injected into
   * the agent's tool catalog. Use this when the host renders the tool result
   * itself (for example via a tool-call renderer reading streamed args) and
   * therefore does not need the MCP Apps activity surface for that tool.
   * The middleware suppresses the final ACTIVITY_SNAPSHOT for tools that
   * have no `resourceUri` (neither tool-linked nor result-scoped via
   * `structuredContent.resourceUri`); the TOOL_CALL_RESULT event still
   * emits, so the host can react to it normally.
   */
  includeToolsWithoutResource?: boolean;
}

/**
 * MCP Client configuration for SSE transport
 */
export interface MCPClientConfigSSE {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  serverId?: string;
  /** See {@link MCPClientConfigHTTP.emitActivity}. */
  emitActivity?: boolean;
  /** See {@link MCPClientConfigHTTP.includeToolsWithoutResource}. */
  includeToolsWithoutResource?: boolean;
}

/**
 * MCP Client configuration
 */
export type MCPClientConfig = MCPClientConfigHTTP | MCPClientConfigSSE;

/**
 * Generate a stable server hash from config using MD5 hash.
 * This allows the frontend to reference servers without knowing their URLs.
 */
export function getServerHash(config: MCPClientConfig): string {
  const serialized = JSON.stringify({
    type: config.type,
    url: config.url,
    headers: config.headers,
  });
  return createHash("md5").update(serialized).digest("hex");
}

/**
 * Configuration for MCPAppsMiddleware
 */
export interface MCPAppsMiddlewareConfig {
  /**
   * List of MCP server configurations
   */
  mcpServers?: MCPClientConfig[];
  /**
   * Optional logger for warnings and errors. Defaults to a console-based
   * logger that forwards to `console.warn` / `console.error`.
   */
  logger?: Logger;
}

const MCP_APPS_RESOURCE_MIME_TYPES = [
  "text/html;profile=mcp-app",
  "text/html+mcp",
] as const;

/**
 * Build an MCP transport for the given server config. Header propagation is
 * shared between SSE and StreamableHTTP transports.
 */
function buildTransport(
  serverConfig: MCPClientConfig,
): SSEClientTransport | StreamableHTTPClientTransport {
  const requestInit = serverConfig.headers
    ? { headers: serverConfig.headers }
    : undefined;
  if (serverConfig.type === "sse") {
    return new SSEClientTransport(new URL(serverConfig.url), { requestInit });
  }
  return new StreamableHTTPClientTransport(new URL(serverConfig.url), {
    requestInit,
  });
}

/**
 * Build an MCP client advertising MCP Apps UI capability.
 */
function buildClient(): Client {
  return new Client(
    { name: "mcp-apps-middleware", version: "1.0.0" },
    {
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: [...MCP_APPS_RESOURCE_MIME_TYPES],
          },
        },
      },
    },
  );
}

interface MCPClientCacheEntry {
  promise: Promise<Client>;
  serverConfig: MCPClientConfig;
}

/**
 * Connection-per-call hurts both latency (extra handshakes) and observability
 * (closing the transport ends any server-initiated notification stream). This
 * cache lazily connects clients keyed by server hash and exposes a single
 * `closeAll` so the owning scope can dispose the whole batch atomically.
 *
 * Failed connects are evicted so a subsequent `get()` retries with a fresh
 * transport instead of replaying a memoized rejection — important when N
 * parallel tool calls hit the same server during a transient outage.
 */
class MCPClientCache {
  private readonly entries = new Map<string, MCPClientCacheEntry>();
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  get(serverConfig: MCPClientConfig): Promise<Client> {
    const key = getServerHash(serverConfig);
    let entry = this.entries.get(key);
    if (!entry) {
      const promise = this.create(serverConfig).catch((err) => {
        this.entries.delete(key);
        throw err;
      });
      entry = { promise, serverConfig };
      this.entries.set(key, entry);
    }
    return entry.promise;
  }

  private async create(serverConfig: MCPClientConfig): Promise<Client> {
    const transport = buildTransport(serverConfig);
    const client = buildClient();
    await client.connect(transport);
    return client;
  }

  async closeAll(): Promise<void> {
    const entries = Array.from(this.entries.values());
    this.entries.clear();
    await Promise.allSettled(
      entries.map(async ({ promise, serverConfig }) => {
        let client: Client;
        try {
          client = await promise;
        } catch {
          // Connect rejection is surfaced where the connect was awaited;
          // suppress here to keep `closeAll` strictly about close failures.
          return;
        }
        try {
          await client.close();
        } catch (err) {
          this.logger.error("Failed to close MCP client", err, {
            serverId: serverConfig.serverId,
            serverHash: getServerHash(serverConfig),
          });
        }
      }),
    );
  }
}

/**
 * Resolve a tool's MCP Apps UI resource URI.
 *
 * Prefers the canonical nested metadata shape (`_meta.ui.resourceUri`) and
 * falls back to the deprecated flat metadata key (`_meta["ui/resourceUri"]`).
 */
function getToolUIResourceUri(tool: {
  _meta?: Record<string, unknown>;
}): string | undefined {
  const meta = tool._meta;
  if (!meta || typeof meta !== "object") {
    return undefined;
  }

  const nestedUI = meta.ui;
  if (nestedUI && typeof nestedUI === "object") {
    const nestedResourceUri = (nestedUI as Record<string, unknown>).resourceUri;
    if (
      typeof nestedResourceUri === "string" &&
      nestedResourceUri.startsWith("ui://")
    ) {
      return nestedResourceUri;
    }
  }

  const flatResourceUri = meta["ui/resourceUri"];
  if (
    typeof flatResourceUri === "string" &&
    flatResourceUri.startsWith("ui://")
  ) {
    return flatResourceUri;
  }

  return undefined;
}

/**
 * Resolve a result-scoped MCP Apps resource URI from a tool result.
 *
 * When a tool returns a concrete UI instance URI in
 * `structuredContent.resourceUri`, prefer that over the tool-linked metadata
 * URI for the emitted activity snapshot.
 */
function getToolResultUIResourceUri(result: unknown): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }

  const structuredContent = (result as Record<string, unknown>)
    .structuredContent;
  if (!structuredContent || typeof structuredContent !== "object") {
    return undefined;
  }

  const resourceUri = (structuredContent as Record<string, unknown>)
    .resourceUri;
  if (typeof resourceUri !== "string") {
    return undefined;
  }

  const normalizedResourceUri = resourceUri.trim();
  if (!normalizedResourceUri.startsWith("ui://")) {
    return undefined;
  }

  return normalizedResourceUri;
}

/**
 * Check if a tool has a UI resource attached (per SEP-1865)
 */
function hasUIResource(tool: { _meta?: Record<string, unknown> }): boolean {
  return !!getToolUIResourceUri(tool);
}

/**
 * Extended tool type that includes MCP Apps metadata
 */
export interface MCPAppTool extends Tool {
  /** UI resource URI from SEP-1865 */
  uiResourceUri?: string;
}

/**
 * Convert MCP tool to AG-UI tool format, preserving UI resource info
 */
function convertMCPToolToAGUITool(mcpTool: {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}): Tool {
  const tool: Tool = {
    name: mcpTool.name,
    description: mcpTool.description || "",
    parameters: mcpTool.inputSchema || { type: "object", properties: {} },
  };

  // Store UI resource URI in the description for now
  // TODO: Once AG-UI Tool type supports _meta, use that instead
  const uiResourceUri = getToolUIResourceUri(mcpTool);
  if (uiResourceUri) {
    tool.description = `${tool.description}\n[UI Resource: ${uiResourceUri}]`;
  }

  return tool;
}

/**
 * MCP Apps middleware - fetches UI-enabled tools from MCP servers.
 */
export class MCPAppsMiddleware extends Middleware {
  private config: MCPAppsMiddlewareConfig;
  private readonly logger: Logger;
  /** Map of serverHash -> server config for proxied requests */
  private serverConfigMapByHash: Map<string, MCPClientConfig> = new Map();
  /** Map of serverId -> server config for proxied requests */
  private serverConfigMapById: Map<string, MCPClientConfig> = new Map();

  constructor(config: MCPAppsMiddlewareConfig = {}) {
    super();
    this.config = config;
    this.logger = config.logger ?? consoleLogger;
    // Build server config maps for proxied requests
    for (const serverConfig of config.mcpServers || []) {
      const serverHash = getServerHash(serverConfig);
      this.serverConfigMapByHash.set(serverHash, serverConfig);
      if (serverConfig.serverId) {
        this.serverConfigMapById.set(serverConfig.serverId, serverConfig);
      }
    }
  }

  run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
    // Check for proxied MCP request mode
    const proxiedRequest = input.forwardedProps?.__proxiedMCPRequest as
      | ProxiedMCPRequest
      | undefined;
    if (proxiedRequest) {
      return this.handleProxiedMCPRequest(input.runId, proxiedRequest);
    }

    // If no MCP servers configured, pass through using runNextWithState
    if (!this.config.mcpServers?.length) {
      return this.processStream(this.runNextWithState(input, next), new Map());
    }

    // Fetch UI tools from MCP servers and inject them
    return from(this.fetchUITools()).pipe(
      switchMap((uiToolInfos) => {
        // Build map of tool name -> UIToolInfo. If two servers expose the
        // same tool name we still route to the last one (preserving prior
        // behavior) but warn so the host can disambiguate via serverId or
        // a per-server prefix.
        const uiToolsMap = new Map<string, UIToolInfo>();
        for (const info of uiToolInfos) {
          const existing = uiToolsMap.get(info.tool.name);
          if (existing) {
            this.logger.warn(
              `[mcp-apps-middleware] Tool name collision: "${info.tool.name}" is exposed by multiple MCP servers. The previous server's tool will be shadowed.`,
              {
                toolName: info.tool.name,
                shadowedServerHash: getServerHash(existing.serverConfig),
                shadowedServerId: existing.serverConfig.serverId,
                winningServerHash: getServerHash(info.serverConfig),
                winningServerId: info.serverConfig.serverId,
              },
            );
          }
          uiToolsMap.set(info.tool.name, info);
        }

        // Merge UI tools with existing input tools
        const enhancedInput: RunAgentInput = {
          ...input,
          tools: [...input.tools, ...uiToolInfos.map((info) => info.tool)],
        };

        // Use runNextWithState to get state with each event
        return this.processStream(
          this.runNextWithState(enhancedInput, next),
          uiToolsMap,
        );
      }),
    );
  }

  /**
   * Handle a proxied MCP request from the frontend iframe.
   * This bypasses the normal agent flow and directly executes the MCP request.
   */
  private handleProxiedMCPRequest(
    runId: string,
    request: ProxiedMCPRequest,
  ): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      // Look up server config - prefer serverId, fallback to serverHash
      let serverConfig: MCPClientConfig | undefined;
      if (request.serverId) {
        serverConfig = this.serverConfigMapById.get(request.serverId);
      }
      if (!serverConfig) {
        serverConfig = this.serverConfigMapByHash.get(request.serverHash);
      }

      // Emit RunStarted
      const runStartedEvent: RunStartedEvent = {
        type: EventType.RUN_STARTED,
        runId,
        threadId: runId,
      };
      subscriber.next(runStartedEvent);

      // Handle unknown server
      if (!serverConfig) {
        const runFinishedEvent: RunFinishedEvent = {
          type: EventType.RUN_FINISHED,
          runId,
          threadId: runId,
          result: {
            error: `Unknown server: ${request.serverId || request.serverHash}`,
          },
        };
        subscriber.next(runFinishedEvent);
        subscriber.complete();
        return;
      }

      // Execute the MCP request
      this.executeMCPRequest(serverConfig, request.method, request.params)
        .then((result) => {
          // Emit RunFinished with the MCP result
          const runFinishedEvent: RunFinishedEvent = {
            type: EventType.RUN_FINISHED,
            runId,
            threadId: runId,
            result,
          };
          subscriber.next(runFinishedEvent);
          subscriber.complete();
        })
        .catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          const runFinishedEvent: RunFinishedEvent = {
            type: EventType.RUN_FINISHED,
            runId,
            threadId: runId,
            result: { error: message },
          };
          subscriber.next(runFinishedEvent);
          subscriber.complete();
        });
    });
  }

  /**
   * Execute a generic MCP request (tools/call, resources/read, etc.)
   */
  private async executeMCPRequest(
    serverConfig: MCPClientConfig,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const transport = buildTransport(serverConfig);
    const client = buildClient();

    try {
      await client.connect(transport);

      // Strict allowlist of MCP methods the iframe proxy is permitted to
      // forward. `ui/*` methods are out of scope (handled by the host),
      // and arbitrary methods are rejected by the `default` arm so a
      // compromised iframe cannot reach mutating MCP surfaces.
      switch (method) {
        case "tools/call":
          return await client.callTool(
            params as { name: string; arguments?: Record<string, unknown> },
          );
        case "resources/read":
          return await client.readResource(params as { uri: string });
        case "resources/list":
          return await client.listResources(
            params as Parameters<Client["listResources"]>[0],
          );
        case "resources/templates/list":
          return await client.listResourceTemplates(
            params as Parameters<Client["listResourceTemplates"]>[0],
          );
        case "prompts/list":
          return await client.listPrompts(
            params as Parameters<Client["listPrompts"]>[0],
          );
        case "prompts/get":
          return await client.getPrompt(
            params as Parameters<Client["getPrompt"]>[0],
          );
        case "tools/list":
          return await client.listTools(
            params as Parameters<Client["listTools"]>[0],
          );
        case "notifications/message":
          // notifications/message is a one-way notification (no response expected)
          await client.notification({
            method: "notifications/message",
            params,
          });
          return { success: true };
        case "ping":
          return await client.ping();
        default:
          throw new Error(`MCP method not allowed for UI proxy: ${method}`);
      }
    } finally {
      await client.close();
    }
  }

  /**
   * Process the event stream, holding back RunFinished events until either:
   * a) Another event comes -> flush the held RunFinished immediately
   * b) Stream ends -> do special processing, then flush RunFinished and complete
   */
  private processStream(
    source: Observable<EventWithState>,
    uiToolsMap: Map<string, UIToolInfo>,
  ): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      let heldRunFinished: EventWithState | null = null;
      let isProcessing = false;

      const subscription = source.subscribe({
        next: (eventWithState) => {
          const event = eventWithState.event;

          // If we have a held RunFinished and a new event comes, flush it first
          if (heldRunFinished) {
            subscriber.next(heldRunFinished.event);
            heldRunFinished = null;
          }

          // If this is a RunFinished event, hold it back
          if (event.type === EventType.RUN_FINISHED) {
            heldRunFinished = eventWithState;
          } else {
            subscriber.next(event);
          }
        },
        error: (err) => {
          // On error, flush any held event and propagate error
          if (heldRunFinished) {
            subscriber.next(heldRunFinished.event);
            heldRunFinished = null;
          }
          subscriber.error(err);
        },
        complete: async () => {
          // Stream ended - do special processing if we have a held RunFinished
          if (heldRunFinished && !isProcessing) {
            isProcessing = true;
            const clientCache = new MCPClientCache(this.logger);

            try {
              // Find tool calls that don't have a corresponding result message
              const pendingToolCalls = this.findPendingToolCalls(
                heldRunFinished.messages,
              );

              // Filter for UI tool calls (tools we injected from MCP servers)
              const pendingUIToolCalls = pendingToolCalls.filter((tc) =>
                uiToolsMap.has(tc.function.name),
              );

              // Execute pending UI tool calls in parallel — they're
              // independent RPCs and the cache reuses one client per
              // server for the whole batch. `subscriber.next` is single-
              // threaded in the JS runtime so concurrent emits remain
              // ordered without explicit synchronization. Use
              // `allSettled` so a rejection in one task (e.g. a
              // user-supplied logger throwing inside `emitToolCallError`)
              // does not strand sibling tool calls' results.
              const settled = await Promise.allSettled(
                pendingUIToolCalls.map((toolCall) =>
                  this.executePendingUIToolCall(
                    toolCall,
                    uiToolsMap.get(toolCall.function.name)!,
                    clientCache,
                    subscriber,
                  ),
                ),
              );
              for (const result of settled) {
                if (result.status === "rejected") {
                  this.logger.error(
                    "Unexpected error in pending UI tool call execution",
                    result.reason,
                  );
                }
              }

              subscriber.next(heldRunFinished.event);
            } finally {
              await clientCache.closeAll();
              heldRunFinished = null;
              isProcessing = false;
            }
          }
          subscriber.complete();
        },
      });

      return () => subscription.unsubscribe();
    });
  }

  /**
   * Execute a single pending UI tool call against its source server and emit
   * the resulting events. Forwards MCP `notifications/progress` to the
   * subscriber as one ACTIVITY_SNAPSHOT (on the first tick) followed by
   * ACTIVITY_DELTA events (on subsequent ticks), all keyed by a stable
   * `messageId` derived from `toolCallId`. This matches AG-UI's canonical
   * streaming pattern (snapshot + JSON-Patch deltas) so the default apply
   * path produces one live-updating activity message per call.
   */
  private async executePendingUIToolCall(
    toolCall: ToolCall,
    toolInfo: UIToolInfo,
    clientCache: MCPClientCache,
    subscriber: { next: (event: BaseEvent) => void },
  ): Promise<void> {
    const toolName = toolCall.function.name;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(toolCall.function.arguments || "{}");
    } catch (error) {
      this.emitToolCallError(
        subscriber,
        toolCall,
        toolName,
        toolInfo.serverConfig,
        error,
      );
      return;
    }

    const progressMessageId = progressMessageIdFor(toolCall.id);
    let lastTick: ProgressTick | undefined;

    const onprogress = (tick: ProgressTick) => {
      if (lastTick === undefined) {
        // First progress notification for this tool call: emit the
        // initial SNAPSHOT so the consumer creates an activity message
        // keyed by `progressMessageId`. `replace: false` keeps later
        // resyncs idempotent: AG-UI's default apply drops a duplicate
        // `replace: false` SNAPSHOT for an existing messageId, so DELTAs
        // remain the authoritative update channel.
        const snapshot: ActivitySnapshotEvent = {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: progressMessageId,
          activityType: MCPAppsProgressActivityType,
          content: {
            progress: tick.progress,
            ...(tick.total !== undefined ? { total: tick.total } : {}),
            ...(tick.message !== undefined ? { message: tick.message } : {}),
            toolCallId: toolCall.id,
            toolName,
            serverHash: getServerHash(toolInfo.serverConfig),
            serverId: toolInfo.serverConfig.serverId,
          },
          replace: false,
        };
        subscriber.next(snapshot);
      } else {
        const patch = buildProgressPatch(lastTick, tick);
        if (patch.length > 0) {
          const delta: ActivityDeltaEvent = {
            type: EventType.ACTIVITY_DELTA,
            messageId: progressMessageId,
            activityType: MCPAppsProgressActivityType,
            patch,
          };
          subscriber.next(delta);
        }
      }
      lastTick = tick;
    };

    try {
      const client = await clientCache.get(toolInfo.serverConfig);
      const mcpResult = await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { onprogress },
      );

      const resultEvent: ToolCallResultEvent = {
        type: EventType.TOOL_CALL_RESULT,
        messageId: randomUUID(),
        toolCallId: toolCall.id,
        content: this.extractTextContent(mcpResult),
      };
      subscriber.next(resultEvent);

      // Emit final activity snapshot. Skip when the caller opted out via
      // emitActivity=false — they render the widget themselves from the
      // tool-call args. Also skip when no resourceUri is available (neither
      // tool-linked nor result-scoped); that only happens for tools surfaced
      // via includeToolsWithoutResource, where there is nothing meaningful
      // to put in `content.resourceUri`.
      const effectiveResourceUri =
        getToolResultUIResourceUri(mcpResult) ?? toolInfo.resourceUri;
      if (
        effectiveResourceUri &&
        toolInfo.serverConfig.emitActivity !== false
      ) {
        const activityEvent: ActivitySnapshotEvent = {
          type: EventType.ACTIVITY_SNAPSHOT,
          messageId: randomUUID(),
          activityType: MCPAppsActivityType,
          content: {
            result: mcpResult,
            resourceUri: effectiveResourceUri,
            serverHash: getServerHash(toolInfo.serverConfig),
            serverId: toolInfo.serverConfig.serverId,
            toolInput: args,
          },
          replace: true,
        };
        subscriber.next(activityEvent);
      }
    } catch (error) {
      this.emitToolCallError(
        subscriber,
        toolCall,
        toolName,
        toolInfo.serverConfig,
        error,
      );
    }
  }

  private emitToolCallError(
    subscriber: { next: (event: BaseEvent) => void },
    toolCall: ToolCall,
    toolName: string,
    serverConfig: MCPClientConfig,
    error: unknown,
  ): void {
    this.logger.error(`Failed to execute UI tool call ${toolName}:`, error, {
      toolName,
      toolCallId: toolCall.id,
      serverId: serverConfig.serverId,
      serverHash: getServerHash(serverConfig),
    });
    const message = error instanceof Error ? error.message : String(error);
    const errorResult: ToolCallResultEvent = {
      type: EventType.TOOL_CALL_RESULT,
      messageId: randomUUID(),
      toolCallId: toolCall.id,
      content: JSON.stringify({ error: message }),
    };
    subscriber.next(errorResult);
  }

  /**
   * Extract text content from MCP result, fallback to JSON stringified content
   */
  private extractTextContent(mcpResult: unknown): string {
    const result = mcpResult as { content?: unknown };
    if (Array.isArray(result.content)) {
      const textContent = result.content
        .filter(
          (c): c is { type: "text"; text: string } =>
            c &&
            typeof c === "object" &&
            c.type === "text" &&
            typeof c.text === "string",
        )
        .map((c) => c.text)
        .join("\n");
      return textContent || JSON.stringify(result.content);
    }
    return JSON.stringify(result.content);
  }

  /**
   * Find tool calls that don't have a corresponding result (role: "tool") message
   */
  private findPendingToolCalls(messages: Message[]): ToolCall[] {
    // Collect all tool calls from assistant messages
    const allToolCalls: ToolCall[] = [];
    for (const message of messages) {
      if (
        message.role === "assistant" &&
        "toolCalls" in message &&
        message.toolCalls
      ) {
        allToolCalls.push(...message.toolCalls);
      }
    }

    // Collect all tool call IDs that have results
    const resolvedToolCallIds = new Set<string>();
    for (const message of messages) {
      if (message.role === "tool" && "toolCallId" in message) {
        resolvedToolCallIds.add(message.toolCallId);
      }
    }

    // Return tool calls that don't have results
    return allToolCalls.filter((tc) => !resolvedToolCallIds.has(tc.id));
  }

  /**
   * Connect to all configured MCP servers and fetch tools with UI resources.
   * Servers are queried in parallel; a failure on one server is logged but
   * does not block the others.
   */
  private async fetchUITools(): Promise<UIToolInfo[]> {
    const servers = this.config.mcpServers || [];
    const settled = await Promise.allSettled(
      servers.map((serverConfig) => this.fetchToolsFromServer(serverConfig)),
    );

    const allUITools: UIToolInfo[] = [];
    settled.forEach((result, idx) => {
      if (result.status === "fulfilled") {
        allUITools.push(...result.value);
      } else {
        const serverConfig = servers[idx];
        this.logger.error(
          `Failed to fetch tools from MCP server ${serverConfig.url}:`,
          result.reason,
        );
      }
    });

    return allUITools;
  }

  /**
   * Connect to a single MCP server and fetch its UI-enabled tools
   */
  private async fetchToolsFromServer(
    serverConfig: MCPClientConfig,
  ): Promise<UIToolInfo[]> {
    const transport = buildTransport(serverConfig);
    const client = buildClient();

    try {
      await client.connect(transport);

      // Fetch tools from the server
      const response = await client.listTools();

      // Filter for tools with UI resources and convert to AG-UI format with
      // server config. Servers configured with includeToolsWithoutResource
      // also surface tools that lack `_meta.ui.resourceUri` so the host can
      // expose the server as a general tool catalog (the activity emit is
      // suppressed downstream for those, since there's no resourceUri to
      // advertise in the snapshot).
      const includeAll = serverConfig.includeToolsWithoutResource === true;
      const uiTools = response.tools.flatMap((mcpTool) => {
        const resourceUri = getToolUIResourceUri(mcpTool);
        if (!resourceUri && !includeAll) {
          return [];
        }

        return [
          {
            tool: convertMCPToolToAGUITool(mcpTool),
            serverConfig,
            resourceUri,
          },
        ];
      });

      return uiTools;
    } finally {
      // Always close the connection
      await client.close();
    }
  }
}
