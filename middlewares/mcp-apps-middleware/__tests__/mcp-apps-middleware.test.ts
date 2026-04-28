/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventType, BaseEvent } from "@ag-ui/client";
import {
  MCPAppsMiddleware,
  MCPClientConfig,
  ProxiedMCPRequest,
  MCPAppsActivityType,
  MCPAppsProgressActivityType,
  Logger,
  getServerHash,
} from "../src/index";
import {
  MockAgent,
  AsyncMockAgent,
  ErrorMockAgent,
  createRunAgentInput,
  createRunStartedEvent,
  createRunFinishedEvent,
  createTextMessageStartEvent,
  createTextMessageContentEvent,
  createTextMessageEndEvent,
  createMCPToolWithUI,
  createMCPToolWithNestedUI,
  createMCPToolWithBothUI,
  createMCPToolWithInvalidUI,
  createMCPToolWithoutUI,
  createMCPToolWithEmptyMeta,
  createAssistantMessageWithToolCalls,
  createToolResultMessage,
  createAGUITool,
  collectEvents,
  createMCPToolCallResult,
} from "./test-utils";

// Create mock functions that will be referenced in the mock factory
const mockConnect = vi.fn();
const mockClose = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();
const mockReadResource = vi.fn();
const mockListResources = vi.fn();
const mockListResourceTemplates = vi.fn();
const mockListPrompts = vi.fn();
const mockGetPrompt = vi.fn();
const mockNotification = vi.fn();
const mockPing = vi.fn();

// Track Client constructor calls
const mockClientConstructorCalls: Array<{
  clientInfo: unknown;
  options: unknown;
}> = [];

// Track transport constructor calls
const mockSSETransportCalls: URL[] = [];
const mockHTTPTransportCalls: URL[] = [];

// Mock the MCP SDK modules - using factory that returns a function returning our mock
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  return {
    Client: class MockClient {
      connect = mockConnect;
      close = mockClose;
      listTools = mockListTools;
      callTool = mockCallTool;
      readResource = mockReadResource;
      listResources = mockListResources;
      listResourceTemplates = mockListResourceTemplates;
      listPrompts = mockListPrompts;
      getPrompt = mockGetPrompt;
      notification = mockNotification;
      ping = mockPing;

      constructor(clientInfo: unknown, options: unknown) {
        mockClientConstructorCalls.push({ clientInfo, options });
      }
    },
  };
});

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSEClientTransport {
    type = "sse";
    constructor(url: URL) {
      mockSSETransportCalls.push(url);
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class MockStreamableHTTPClientTransport {
    type = "http";
    constructor(url: URL) {
      mockHTTPTransportCalls.push(url);
    }
  },
}));

// Mock crypto.randomUUID but keep createHash real
vi.mock("crypto", async () => {
  const actual = await vi.importActual<typeof import("crypto")>("crypto");
  return {
    ...actual,
    randomUUID: vi.fn(
      () => `mock-uuid-${Math.random().toString(36).substr(2, 9)}`,
    ),
  };
});

describe("MCPAppsMiddleware", () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();

    // Clear constructor calls tracking
    mockClientConstructorCalls.length = 0;
    mockSSETransportCalls.length = 0;
    mockHTTPTransportCalls.length = 0;

    // Set default mock implementations
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [] });
    mockReadResource.mockResolvedValue({ contents: [] });
    mockListResources.mockResolvedValue({ resources: [] });
    mockListResourceTemplates.mockResolvedValue({ resourceTemplates: [] });
    mockListPrompts.mockResolvedValue({ prompts: [] });
    mockGetPrompt.mockResolvedValue({ messages: [] });
    mockNotification.mockResolvedValue(undefined);
    mockPing.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =============================================================================
  // 1. Constructor & Configuration Tests
  // =============================================================================
  describe("Constructor & Configuration", () => {
    it("creates instance with empty config", () => {
      const middleware = new MCPAppsMiddleware();
      expect(middleware).toBeInstanceOf(MCPAppsMiddleware);
    });

    it("creates instance with empty object config", () => {
      const middleware = new MCPAppsMiddleware({});
      expect(middleware).toBeInstanceOf(MCPAppsMiddleware);
    });

    it("creates instance with HTTP server config", () => {
      const config = {
        mcpServers: [{ type: "http" as const, url: "http://localhost:3000" }],
      };
      const middleware = new MCPAppsMiddleware(config);
      expect(middleware).toBeInstanceOf(MCPAppsMiddleware);
    });

    it("creates instance with SSE server config", () => {
      const config = {
        mcpServers: [
          { type: "sse" as const, url: "http://localhost:3000/sse" },
        ],
      };
      const middleware = new MCPAppsMiddleware(config);
      expect(middleware).toBeInstanceOf(MCPAppsMiddleware);
    });

    it("creates instance with SSE server config including headers", () => {
      const config = {
        mcpServers: [
          {
            type: "sse" as const,
            url: "http://localhost:3000/sse",
            headers: { Authorization: "Bearer token" },
          },
        ],
      };
      const middleware = new MCPAppsMiddleware(config);
      expect(middleware).toBeInstanceOf(MCPAppsMiddleware);
    });

    it("creates instance with multiple server configs", () => {
      const config = {
        mcpServers: [
          { type: "http" as const, url: "http://localhost:3001" },
          { type: "sse" as const, url: "http://localhost:3002/sse" },
        ],
      };
      const middleware = new MCPAppsMiddleware(config);
      expect(middleware).toBeInstanceOf(MCPAppsMiddleware);
    });
  });

  // =============================================================================
  // 2. Pass-Through Behavior (No MCP Servers)
  // =============================================================================
  describe("Pass-Through Behavior (No MCP Servers)", () => {
    it("passes through when mcpServers is empty array", async () => {
      const middleware = new MCPAppsMiddleware({ mcpServers: [] });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const events = await collectEvents(
        middleware.run(createRunAgentInput(), agent),
      );

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe(EventType.RUN_STARTED);
      expect(events[1].type).toBe(EventType.RUN_FINISHED);
    });

    it("passes through when mcpServers is undefined", async () => {
      const middleware = new MCPAppsMiddleware({});
      const agent = new MockAgent([
        createRunStartedEvent(),
        createTextMessageStartEvent(),
        createTextMessageContentEvent(),
        createTextMessageEndEvent(),
        createRunFinishedEvent(),
      ]);

      const events = await collectEvents(
        middleware.run(createRunAgentInput(), agent),
      );

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].type).toBe(EventType.RUN_STARTED);
      expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
    });

    it("events flow through unchanged when no servers configured", async () => {
      const middleware = new MCPAppsMiddleware();
      const inputEvents = [
        createRunStartedEvent("run-1", "thread-1"),
        createTextMessageStartEvent("msg-1"),
        createTextMessageContentEvent("msg-1", "Hello World"),
        createTextMessageEndEvent("msg-1"),
        createRunFinishedEvent("run-1", "thread-1", { success: true }),
      ];
      const agent = new MockAgent(inputEvents);

      const events = await collectEvents(
        middleware.run(createRunAgentInput(), agent),
      );

      // The middleware uses runNextWithState which transforms chunks
      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(events[0].type).toBe(EventType.RUN_STARTED);
    });

    it("observable completes correctly with no servers", async () => {
      const middleware = new MCPAppsMiddleware();
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      let completed = false;
      await new Promise<void>((resolve) => {
        middleware.run(createRunAgentInput(), agent).subscribe({
          complete: () => {
            completed = true;
            resolve();
          },
        });
      });

      expect(completed).toBe(true);
    });

    it("error propagation works with no servers", async () => {
      const middleware = new MCPAppsMiddleware();
      const testError = new Error("Test error");
      const agent = new ErrorMockAgent(testError);

      let caughtError: Error | null = null;
      await new Promise<void>((resolve) => {
        middleware.run(createRunAgentInput(), agent).subscribe({
          error: (err) => {
            caughtError = err;
            resolve();
          },
          complete: () => resolve(),
        });
      });

      expect(caughtError).toBe(testError);
    });
  });

  // =============================================================================
  // 3. Tool Discovery Tests
  // =============================================================================
  describe("Tool Discovery", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };
    const sseServerConfig: MCPClientConfig = {
      type: "sse",
      url: "http://localhost:3001/sse",
    };

    it("connects to MCP server with correct capabilities", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(mockClientConstructorCalls).toHaveLength(1);
      expect(mockClientConstructorCalls[0].clientInfo).toEqual({
        name: "mcp-apps-middleware",
        version: "1.0.0",
      });
      expect(mockClientConstructorCalls[0].options).toMatchObject({
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": {
              mimeTypes: ["text/html;profile=mcp-app", "text/html+mcp"],
            },
          },
        },
      });
    });

    it("calls listTools on connected client", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(mockConnect).toHaveBeenCalled();
      expect(mockListTools).toHaveBeenCalled();
    });

    it("filters tools by supported UI metadata presence", async () => {
      mockListTools.mockResolvedValue({
        tools: [
          createMCPToolWithNestedUI("nested-ui-tool", "ui://server/nested"),
          createMCPToolWithUI("flat-ui-tool", "ui://server/flat"),
          createMCPToolWithoutUI("non-ui-tool"),
          createMCPToolWithEmptyMeta("meta-but-no-ui"),
          createMCPToolWithInvalidUI(
            "invalid-ui-tool",
            "https://server/not-ui",
          ),
        ],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(agent.runCalls).toHaveLength(1);
      const enhancedTools = agent.runCalls[0].tools;
      expect(enhancedTools).toHaveLength(2);
      expect(enhancedTools.map((tool) => tool.name)).toEqual([
        "nested-ui-tool",
        "flat-ui-tool",
      ]);
    });

    it("converts MCP tools with nested metadata to AG-UI Tool format correctly", async () => {
      mockListTools.mockResolvedValue({
        tools: [
          {
            name: "test-tool",
            description: "Test tool description",
            inputSchema: {
              type: "object",
              properties: { foo: { type: "string" } },
            },
            _meta: { ui: { resourceUri: "ui://server/test" } },
          },
        ],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      const enhancedTools = agent.runCalls[0].tools;
      expect(enhancedTools[0].name).toBe("test-tool");
      expect(enhancedTools[0].description).toContain("Test tool description");
      expect(enhancedTools[0].parameters).toEqual({
        type: "object",
        properties: { foo: { type: "string" } },
      });
    });

    it("stores the canonical UI resource URI in description", async () => {
      mockListTools.mockResolvedValue({
        tools: [
          createMCPToolWithNestedUI(
            "ui-tool",
            "ui://server/dashboard",
            "Original description",
          ),
        ],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      const enhancedTools = agent.runCalls[0].tools;
      expect(enhancedTools[0].description).toContain("Original description");
      expect(enhancedTools[0].description).toContain(
        "[UI Resource: ui://server/dashboard]",
      );
    });

    it("prefers nested ui.resourceUri over deprecated flat metadata", async () => {
      mockListTools.mockResolvedValue({
        tools: [
          createMCPToolWithBothUI(
            "ui-tool",
            "ui://server/canonical",
            "ui://server/legacy",
            "Original description",
          ),
        ],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      const enhancedTool = agent.runCalls[0].tools[0];
      expect(enhancedTool.description).toContain(
        "[UI Resource: ui://server/canonical]",
      );
      expect(enhancedTool.description).not.toContain("ui://server/legacy");
    });

    it("rejects invalid UI resource URIs", async () => {
      mockListTools.mockResolvedValue({
        tools: [
          createMCPToolWithInvalidUI("non-ui-scheme", "https://server/not-ui"),
          createMCPToolWithInvalidUI("non-string-ui", 42),
          createMCPToolWithInvalidUI("empty-ui", ""),
        ],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(agent.runCalls[0].tools).toHaveLength(0);
    });

    it("handles tools without _meta", async () => {
      mockListTools.mockResolvedValue({
        tools: [createMCPToolWithoutUI("no-meta-tool")],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      // No UI tools should be added
      expect(agent.runCalls[0].tools).toHaveLength(0);
    });

    it("handles empty tools list from server", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(agent.runCalls[0].tools).toHaveLength(0);
    });

    it("handles server connection failures gracefully", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      mockConnect.mockRejectedValue(new Error("Connection failed"));

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      // Should not throw, should continue
      const events = await collectEvents(
        middleware.run(createRunAgentInput(), agent),
      );

      expect(events.length).toBeGreaterThanOrEqual(2);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch tools from MCP server"),
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();
    });

    it("closes client connection after fetching tools", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(mockClose).toHaveBeenCalled();
    });

    it("works with HTTP transport", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [{ type: "http", url: "http://localhost:3000" }],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(mockHTTPTransportCalls).toHaveLength(1);
      expect(mockHTTPTransportCalls[0].toString()).toBe(
        "http://localhost:3000/",
      );
    });

    it("works with SSE transport", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [{ type: "sse", url: "http://localhost:3001/sse" }],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(mockSSETransportCalls).toHaveLength(1);
      expect(mockSSETransportCalls[0].toString()).toBe(
        "http://localhost:3001/sse",
      );
    });

    it("aggregates tools from multiple servers", async () => {
      // We need to track which server each call is for
      let callCount = 0;
      mockListTools.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            tools: [createMCPToolWithUI("tool-1", "ui://server1/tool1")],
          });
        }
        return Promise.resolve({
          tools: [createMCPToolWithUI("tool-2", "ui://server2/tool2")],
        });
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig, sseServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(agent.runCalls[0].tools).toHaveLength(2);
      expect(agent.runCalls[0].tools.map((t) => t.name)).toContain("tool-1");
      expect(agent.runCalls[0].tools.map((t) => t.name)).toContain("tool-2");
    });
  });

  // =============================================================================
  // 4. Tool Injection Tests
  // =============================================================================
  describe("Tool Injection", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("merges UI tools with existing input tools", async () => {
      mockListTools.mockResolvedValue({
        tools: [createMCPToolWithUI("ui-tool", "ui://server/dashboard")],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const existingTool = createAGUITool("existing-tool");
      const input = createRunAgentInput({ tools: [existingTool] });

      await collectEvents(middleware.run(input, agent));

      expect(agent.runCalls[0].tools).toHaveLength(2);
      expect(agent.runCalls[0].tools[0].name).toBe("existing-tool");
      expect(agent.runCalls[0].tools[1].name).toBe("ui-tool");
    });

    it("preserves original input tools", async () => {
      mockListTools.mockResolvedValue({
        tools: [createMCPToolWithUI("ui-tool", "ui://server/dashboard")],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const originalTools = [
        createAGUITool("tool-a", "Description A"),
        createAGUITool("tool-b", "Description B"),
      ];
      const input = createRunAgentInput({ tools: originalTools });

      await collectEvents(middleware.run(input, agent));

      const resultTools = agent.runCalls[0].tools;
      expect(resultTools[0]).toEqual(originalTools[0]);
      expect(resultTools[1]).toEqual(originalTools[1]);
    });

    it("passes enhanced input to next agent", async () => {
      mockListTools.mockResolvedValue({
        tools: [createMCPToolWithUI("ui-tool", "ui://server/dashboard")],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const input = createRunAgentInput({
        threadId: "custom-thread",
        runId: "custom-run",
        state: { key: "value" },
      });

      await collectEvents(middleware.run(input, agent));

      expect(agent.runCalls[0].threadId).toBe("custom-thread");
      expect(agent.runCalls[0].runId).toBe("custom-run");
      expect(agent.runCalls[0].state).toEqual({ key: "value" });
      expect(agent.runCalls[0].tools.length).toBe(1);
    });
  });

  // =============================================================================
  // 5. Event Stream Processing Tests
  // =============================================================================
  describe("Event Stream Processing", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("emits non-RUN_FINISHED events immediately", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createTextMessageStartEvent(),
        createTextMessageContentEvent(),
        createTextMessageEndEvent(),
        createRunFinishedEvent(),
      ]);

      const receivedEvents: BaseEvent[] = [];
      await new Promise<void>((resolve) => {
        middleware.run(createRunAgentInput(), agent).subscribe({
          next: (event) => receivedEvents.push(event),
          complete: () => resolve(),
        });
      });

      // First event should be RUN_STARTED
      expect(receivedEvents[0].type).toBe(EventType.RUN_STARTED);
      // Last event should be RUN_FINISHED
      expect(receivedEvents[receivedEvents.length - 1].type).toBe(
        EventType.RUN_FINISHED,
      );
    });

    it("holds back RUN_FINISHED event until stream ends", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new AsyncMockAgent(
        [createRunStartedEvent(), createRunFinishedEvent()],
        10,
      );

      const receivedEvents: BaseEvent[] = [];
      let finishedReceived = false;

      await new Promise<void>((resolve) => {
        middleware.run(createRunAgentInput(), agent).subscribe({
          next: (event) => {
            receivedEvents.push(event);
            if (event.type === EventType.RUN_FINISHED) {
              finishedReceived = true;
            }
          },
          complete: () => resolve(),
        });
      });

      expect(finishedReceived).toBe(true);
      expect(receivedEvents[receivedEvents.length - 1].type).toBe(
        EventType.RUN_FINISHED,
      );
    });

    it("handles error events correctly", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const testError = new Error("Stream error");
      const agent = new ErrorMockAgent(testError);

      let caughtError: Error | null = null;
      await new Promise<void>((resolve) => {
        middleware.run(createRunAgentInput(), agent).subscribe({
          error: (err) => {
            caughtError = err;
            resolve();
          },
          complete: () => resolve(),
        });
      });

      expect(caughtError).toBe(testError);
    });

    it("subscription cleanup works", async () => {
      mockListTools.mockResolvedValue({ tools: [] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new AsyncMockAgent(
        [
          createRunStartedEvent(),
          createTextMessageStartEvent(),
          createTextMessageContentEvent(),
          createRunFinishedEvent(),
        ],
        50,
      );

      let eventCount = 0;
      const subscription = middleware
        .run(createRunAgentInput(), agent)
        .subscribe({
          next: () => {
            eventCount++;
            if (eventCount === 2) {
              subscription.unsubscribe();
            }
          },
        });

      // Wait a bit to ensure no more events are received after unsubscribe
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(eventCount).toBe(2);
    });
  });

  // =============================================================================
  // 6. Pending Tool Call Detection Tests
  // =============================================================================
  describe("Pending Tool Call Detection", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("processes pending UI tool calls on stream completion", async () => {
      const uiTool = createMCPToolWithUI(
        "ui-weather",
        "ui://weather/dashboard",
      );
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Weather result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      // Create an assistant message with a tool call that won't have a result
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-weather", args: { city: "London" }, id: "tc-1" },
      ]);

      // Agent emits events but doesn't emit a tool result
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      // Set up input with the assistant message containing the tool call
      const input = createRunAgentInput({
        messages: [assistantMsg],
      });

      const events = await collectEvents(middleware.run(input, agent));

      // Should have emitted TOOL_CALL_RESULT and ACTIVITY_SNAPSHOT events
      const toolResultEvents = events.filter(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      const activityEvents = events.filter(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );

      expect(toolResultEvents.length).toBe(1);
      expect(activityEvents.length).toBe(1);
    });

    it("skips ACTIVITY_SNAPSHOT when the server config opts out via emitActivity=false", async () => {
      const uiTool = createMCPToolWithUI(
        "ui-weather-quiet",
        "ui://weather/quiet",
      );
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Weather result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [{ ...httpServerConfig, emitActivity: false }],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-weather-quiet", args: { city: "Berlin" }, id: "tc-q" },
      ]);
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const toolResultEvents = events.filter(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      const activityEvents = events.filter(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );

      // Tool result still flows through — the opt-out only suppresses the
      // activity snapshot so the frontend's toolcall renderer can own the
      // widget surface without double-mounting.
      expect(toolResultEvents.length).toBe(1);
      expect(activityEvents.length).toBe(0);
    });

    it("identifies resolved tool calls (role: tool messages)", async () => {
      const uiTool = createMCPToolWithUI(
        "ui-weather",
        "ui://weather/dashboard",
      );
      mockListTools.mockResolvedValue({ tools: [uiTool] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      // Create assistant message with tool call AND a tool result message
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-weather", args: { city: "London" }, id: "tc-1" },
      ]);
      const toolResultMsg = createToolResultMessage("tc-1", "Already resolved");

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const input = createRunAgentInput({
        messages: [assistantMsg, toolResultMsg],
      });

      const events = await collectEvents(middleware.run(input, agent));

      // Should NOT emit additional TOOL_CALL_RESULT since it's already resolved
      const toolResultEvents = events.filter(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      expect(toolResultEvents.length).toBe(0);
    });

    it("handles empty message arrays", async () => {
      mockListTools.mockResolvedValue({
        tools: [createMCPToolWithUI("ui-tool", "ui://server/tool")],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const input = createRunAgentInput({ messages: [] });
      const events = await collectEvents(middleware.run(input, agent));

      // Should complete without errors
      expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
    });

    it("handles messages without tool calls", async () => {
      mockListTools.mockResolvedValue({
        tools: [createMCPToolWithUI("ui-tool", "ui://server/tool")],
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const input = createRunAgentInput({
        messages: [
          { id: "msg-1", role: "user", content: "Hello" },
          { id: "msg-2", role: "assistant", content: "Hi there" },
        ],
      });

      const events = await collectEvents(middleware.run(input, agent));

      // Should complete without emitting tool results
      const toolResultEvents = events.filter(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      expect(toolResultEvents.length).toBe(0);
    });

    it("handles multiple tool calls per message", async () => {
      const uiTool1 = createMCPToolWithUI(
        "ui-weather",
        "ui://weather/dashboard",
      );
      const uiTool2 = createMCPToolWithUI("ui-stocks", "ui://stocks/chart");
      mockListTools.mockResolvedValue({ tools: [uiTool1, uiTool2] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-weather", args: {}, id: "tc-1" },
        { name: "ui-stocks", args: {}, id: "tc-2" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const toolResultEvents = events.filter(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      expect(toolResultEvents.length).toBe(2);
    });
  });

  // =============================================================================
  // 7. Tool Execution Tests
  // =============================================================================
  describe("Tool Execution", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("passes correct tool name and arguments", async () => {
      const uiTool = createMCPToolWithUI(
        "ui-weather",
        "ui://weather/dashboard",
      );
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Sunny" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        {
          name: "ui-weather",
          args: { city: "London", units: "metric" },
          id: "tc-1",
        },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      await collectEvents(middleware.run(input, agent));

      expect(mockCallTool).toHaveBeenCalledWith(
        {
          name: "ui-weather",
          arguments: { city: "London", units: "metric" },
        },
        undefined,
        expect.objectContaining({ onprogress: expect.any(Function) }),
      );
    });

    it("returns raw MCP result", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });

      const mcpResult = createMCPToolCallResult([
        { type: "text", text: "First" },
        { type: "text", text: "Second" },
      ]);
      mockCallTool.mockResolvedValue(mcpResult);

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).content.result).toEqual(mcpResult);
    });

    it("handles tool execution errors", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockRejectedValue(new Error("Execution failed"));

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      // Should emit error tool result
      const toolResultEvents = events.filter(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      expect(toolResultEvents.length).toBe(1);
      expect((toolResultEvents[0] as any).content).toContain("error");

      consoleErrorSpy.mockRestore();
    });

    it("closes connection after execution", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      await collectEvents(middleware.run(input, agent));

      // close should be called multiple times (once for listTools, once for callTool)
      expect(mockClose).toHaveBeenCalled();
    });
  });

  // =============================================================================
  // 7b. Metadata Compatibility Tests
  // =============================================================================
  describe("Metadata Compatibility", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("uses nested metadata resourceUri in activity snapshots", async () => {
      const uiTool = createMCPToolWithNestedUI(
        "ui-tool",
        "ui://server/nested-widget",
      );
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).content.resourceUri).toBe(
        "ui://server/nested-widget",
      );
    });

    it("falls back to deprecated flat metadata in activity snapshots", async () => {
      const uiTool = createMCPToolWithUI(
        "ui-tool",
        "ui://server/legacy-widget",
      );
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).content.resourceUri).toBe(
        "ui://server/legacy-widget",
      );
    });

    it("prefers nested metadata over deprecated flat metadata in activity snapshots", async () => {
      const uiTool = createMCPToolWithBothUI(
        "ui-tool",
        "ui://server/canonical-widget",
        "ui://server/legacy-widget",
      );
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).content.resourceUri).toBe(
        "ui://server/canonical-widget",
      );
    });
  });

  // =============================================================================
  // 8. Activity Snapshot ResourceUri Tests
  // =============================================================================
  describe("Activity Snapshot ResourceUri", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("prefers structuredContent.resourceUri over tool metadata in activity snapshots", async () => {
      const uiTool = createMCPToolWithNestedUI(
        "ui-tool",
        "ui://server/widget-template",
      );
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult(
          [{ type: "text", text: "Result" }],
          {
            structuredContent: {
              resourceUri: "ui://server/widget-123",
            },
          },
        ),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).content.resourceUri).toBe(
        "ui://server/widget-123",
      );
    });

    it("falls back to tool metadata when structuredContent.resourceUri is blank", async () => {
      const uiTool = createMCPToolWithNestedUI(
        "ui-tool",
        "ui://server/widget-template",
      );
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult(
          [{ type: "text", text: "Result" }],
          {
            structuredContent: {
              resourceUri: "   ",
            },
          },
        ),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).content.resourceUri).toBe(
        "ui://server/widget-template",
      );
    });

    it("includes resourceUri in activity snapshot instead of resource content", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/dashboard");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).content.resourceUri).toBe(
        "ui://server/dashboard",
      );
      // Should NOT have resource content (frontend fetches it)
      expect((activityEvent as any).content.resource).toBeUndefined();
    });

    it("does not call readResource during tool execution", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      await collectEvents(middleware.run(input, agent));

      // readResource should NOT be called during tool execution
      // (frontend will fetch via proxied request)
      expect(mockReadResource).not.toHaveBeenCalled();
    });
  });

  // =============================================================================
  // 9. Tool Result Events Tests
  // =============================================================================
  describe("Tool Result Events", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("emits TOOL_CALL_RESULT event with correct toolCallId", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "specific-tc-id" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const toolResultEvent = events.find(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      expect((toolResultEvent as any).toolCallId).toBe("specific-tc-id");
    });

    it("extracts text content from MCP result", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([
          { type: "text", text: "Line 1" },
          { type: "text", text: "Line 2" },
        ]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const toolResultEvent = events.find(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      expect((toolResultEvent as any).content).toBe("Line 1\nLine 2");
    });

    it("falls back to JSON.stringify for non-text content", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "image", data: "base64data" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const toolResultEvent = events.find(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      expect((toolResultEvent as any).content).toContain("image");
      expect((toolResultEvent as any).content).toContain("base64data");
    });

    it("emits ACTIVITY_SNAPSHOT with MCP result and resourceUri", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });

      const mcpResult = createMCPToolCallResult([
        { type: "text", text: "Result" },
      ]);
      mockCallTool.mockResolvedValue(mcpResult);

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).content.result).toEqual(mcpResult);
      expect((activityEvent as any).content.resourceUri).toBe(
        "ui://server/tool",
      );
      // Should NOT have resource content
      expect((activityEvent as any).content.resource).toBeUndefined();
    });

    it("sets activityType to mcp-apps", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect((activityEvent as any).activityType).toBe(MCPAppsActivityType);
      expect((activityEvent as any).activityType).toBe("mcp-apps");
    });

    it("sets replace: true on activity snapshot", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect((activityEvent as any).replace).toBe(true);
    });
  });

  // =============================================================================
  // 10. MCPAppsActivityType Export Tests
  // =============================================================================
  describe("MCPAppsActivityType Export", () => {
    it("exports MCPAppsActivityType constant", () => {
      expect(MCPAppsActivityType).toBeDefined();
      expect(MCPAppsActivityType).toBe("mcp-apps");
    });
  });

  // =============================================================================
  // 11. Proxied MCP Request Mode Tests
  // =============================================================================
  describe("Proxied MCP Request Mode", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("detects proxied request in forwardedProps", async () => {
      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: getServerHash(httpServerConfig),
        method: "ping",
      };

      const input = createRunAgentInput({
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });

      const events = await collectEvents(middleware.run(input, agent));

      // Should bypass normal agent flow (agent.run should not be called with our input)
      expect(events[0].type).toBe(EventType.RUN_STARTED);
      expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
    });

    it("emits RUN_STARTED event", async () => {
      mockPing.mockResolvedValue({});

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([]);

      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: getServerHash(httpServerConfig),
        method: "ping",
      };

      const input = createRunAgentInput({
        runId: "proxy-run",
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });

      const events = await collectEvents(middleware.run(input, agent));

      expect(events[0].type).toBe(EventType.RUN_STARTED);
      expect((events[0] as any).runId).toBe("proxy-run");
    });

    it("emits RUN_FINISHED with result on success", async () => {
      const pingResult = { timestamp: Date.now() };
      mockPing.mockResolvedValue(pingResult);

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([]);

      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: getServerHash(httpServerConfig),
        method: "ping",
      };

      const input = createRunAgentInput({
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });

      const events = await collectEvents(middleware.run(input, agent));

      const finishedEvent = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      );
      expect(finishedEvent).toBeDefined();
      expect((finishedEvent as any).result).toEqual(pingResult);
    });

    it("emits RUN_FINISHED with error on failure", async () => {
      mockConnect.mockRejectedValue(new Error("Connection refused"));

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([]);

      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: getServerHash(httpServerConfig),
        method: "ping",
      };

      const input = createRunAgentInput({
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });

      const events = await collectEvents(middleware.run(input, agent));

      const finishedEvent = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      );
      expect((finishedEvent as any).result.error).toContain(
        "Connection refused",
      );
    });

    it("emits error for unknown serverHash", async () => {
      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([]);

      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: "unknown-server-hash",
        method: "ping",
      };

      const input = createRunAgentInput({
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });

      const events = await collectEvents(middleware.run(input, agent));

      const finishedEvent = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      );
      expect((finishedEvent as any).result.error).toContain("Unknown server");
    });

    it("bypasses normal agent flow", async () => {
      mockPing.mockResolvedValue({});

      const middleware = new MCPAppsMiddleware({
        mcpServers: [{ type: "http", url: "http://localhost:3001" }],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: getServerHash({
          type: "http",
          url: "http://localhost:3001",
        }),
        method: "ping",
      };

      const input = createRunAgentInput({
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });

      await collectEvents(middleware.run(input, agent));

      // Agent's run should not have been called
      expect(agent.runCalls).toHaveLength(0);
    });
  });

  // =============================================================================
  // 12. Server Hash Tests
  // =============================================================================
  describe("Server Hash", () => {
    it("generates consistent serverHash for same config", () => {
      const config: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
      };
      const id1 = getServerHash(config);
      const id2 = getServerHash(config);
      expect(id1).toBe(id2);
    });

    it("generates different serverHashes for different URLs", () => {
      const config1: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
      };
      const config2: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3001",
      };
      expect(getServerHash(config1)).not.toBe(getServerHash(config2));
    });

    it("generates different serverHashes for different types", () => {
      const config1: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
      };
      const config2: MCPClientConfig = {
        type: "sse",
        url: "http://localhost:3000",
      };
      expect(getServerHash(config1)).not.toBe(getServerHash(config2));
    });

    it("generates different serverHashes for SSE configs with different headers", () => {
      const config1: MCPClientConfig = {
        type: "sse",
        url: "http://localhost:3000",
        headers: { Authorization: "token1" },
      };
      const config2: MCPClientConfig = {
        type: "sse",
        url: "http://localhost:3000",
        headers: { Authorization: "token2" },
      };
      expect(getServerHash(config1)).not.toBe(getServerHash(config2));
    });

    it("includes serverHash in ACTIVITY_SNAPSHOT content", async () => {
      const httpServerConfig: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
      };
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).content.serverHash).toBe(
        getServerHash(httpServerConfig),
      );
      // Should NOT have serverUrl or serverType or old serverId
      expect((activityEvent as any).content.serverUrl).toBeUndefined();
      expect((activityEvent as any).content.serverType).toBeUndefined();
      expect((activityEvent as any).content.serverId).toBeUndefined();
    });
  });

  // =============================================================================
  // 13. Server ID Tests
  // =============================================================================
  describe("Server ID", () => {
    it("includes serverId in ACTIVITY_SNAPSHOT when configured", async () => {
      const httpServerConfig: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
        serverId: "my-weather-server",
      };
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).content.serverId).toBe("my-weather-server");
    });

    it("serverId is undefined in ACTIVITY_SNAPSHOT when not configured", async () => {
      const httpServerConfig: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
      };
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "Result" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });

      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);

      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);
      const input = createRunAgentInput({ messages: [assistantMsg] });

      const events = await collectEvents(middleware.run(input, agent));

      const activityEvent = events.find(
        (e) => e.type === EventType.ACTIVITY_SNAPSHOT,
      );
      expect(activityEvent).toBeDefined();
      expect((activityEvent as any).content.serverId).toBeUndefined();
    });

    it("looks up server by serverId in proxied requests", async () => {
      mockPing.mockResolvedValue({});

      const httpServerConfig: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
        serverId: "my-server",
      };
      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([]);

      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: "wrong-hash", // Wrong hash, but serverId should work
        serverId: "my-server",
        method: "ping",
      };

      const input = createRunAgentInput({
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });

      const events = await collectEvents(middleware.run(input, agent));

      const finishedEvent = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      );
      // Should succeed because serverId lookup worked
      expect((finishedEvent as any).result.error).toBeUndefined();
    });

    it("falls back to serverHash when serverId not found", async () => {
      mockPing.mockResolvedValue({});

      const httpServerConfig: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
        serverId: "my-server",
      };
      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([]);

      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: getServerHash(httpServerConfig),
        serverId: "non-existent-server", // Wrong name, should fall back to hash
        method: "ping",
      };

      const input = createRunAgentInput({
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });

      const events = await collectEvents(middleware.run(input, agent));

      const finishedEvent = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      );
      // Should succeed because serverHash fallback worked
      expect((finishedEvent as any).result.error).toBeUndefined();
    });

    it("returns error when neither serverId nor serverHash match", async () => {
      const httpServerConfig: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
        serverId: "my-server",
      };
      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([]);

      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: "wrong-hash",
        serverId: "wrong-name",
        method: "ping",
      };

      const input = createRunAgentInput({
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });

      const events = await collectEvents(middleware.run(input, agent));

      const finishedEvent = events.find(
        (e) => e.type === EventType.RUN_FINISHED,
      );
      expect((finishedEvent as any).result.error).toContain("Unknown server");
    });
  });

  // =============================================================================
  // 12. Pluggable Logger Tests
  // =============================================================================
  describe("Pluggable Logger", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    function makeMockLogger(): Logger & {
      warn: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    } {
      return {
        warn: vi.fn(),
        error: vi.fn(),
      };
    }

    it("routes fetchUITools failures through the logger instead of console", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const logger = makeMockLogger();
      mockConnect.mockRejectedValueOnce(new Error("Connection refused"));

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
        logger,
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch tools from MCP server"),
        expect.any(Error),
      );
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it("routes tool execution failures through the logger instead of console", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const logger = makeMockLogger();
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockRejectedValue(new Error("Boom"));

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
        logger,
      });
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(
        middleware.run(
          createRunAgentInput({ messages: [assistantMsg] }),
          agent,
        ),
      );

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to execute UI tool call ui-tool"),
        expect.any(Error),
        expect.objectContaining({
          toolName: "ui-tool",
          toolCallId: "tc-1",
          serverHash: expect.any(String),
        }),
      );
      expect(consoleErrorSpy).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it("preserves Error.message in the emitted error tool result", async () => {
      const logger = makeMockLogger();
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockRejectedValue(new Error("Specific failure detail"));

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
        logger,
      });
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const events = await collectEvents(
        middleware.run(
          createRunAgentInput({ messages: [assistantMsg] }),
          agent,
        ),
      );

      const result = events.find(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      const parsed = JSON.parse((result as any).content);
      expect(parsed.error).toBe("Specific failure detail");
    });

    it("falls back to console when no logger is configured", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      mockConnect.mockRejectedValueOnce(new Error("Connection refused"));

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to fetch tools from MCP server"),
        expect.any(Error),
      );
      consoleErrorSpy.mockRestore();
    });
  });

  // =============================================================================
  // 13. Tool Name Collision Detection
  // =============================================================================
  describe("Tool Name Collision Detection", () => {
    it("warns through the logger when two servers expose the same tool name", async () => {
      const logger: Logger & {
        warn: ReturnType<typeof vi.fn>;
        error: ReturnType<typeof vi.fn>;
      } = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      const serverA: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
        serverId: "server-a",
      };
      const serverB: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3001",
        serverId: "server-b",
      };

      const sharedTool = createMCPToolWithUI(
        "weather",
        "ui://weather/widget",
      );
      mockListTools.mockResolvedValue({ tools: [sharedTool] });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [serverA, serverB],
        logger,
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Tool name collision"),
        expect.objectContaining({
          toolName: "weather",
          shadowedServerId: "server-a",
          winningServerId: "server-b",
        }),
      );
    });

    it("does not warn for distinct tool names across servers", async () => {
      const logger: Logger & {
        warn: ReturnType<typeof vi.fn>;
        error: ReturnType<typeof vi.fn>;
      } = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      const serverA: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
      };
      const serverB: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3001",
      };

      mockListTools
        .mockResolvedValueOnce({
          tools: [createMCPToolWithUI("tool-a", "ui://a")],
        })
        .mockResolvedValueOnce({
          tools: [createMCPToolWithUI("tool-b", "ui://b")],
        });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [serverA, serverB],
        logger,
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  // =============================================================================
  // 14. Streaming Progress + Parallel Execution
  // =============================================================================
  describe("Streaming and Parallelism", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("forwards first onprogress as a SNAPSHOT and subsequent ticks as DELTAs", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });

      // Drive the onprogress callback the SDK passes via RequestOptions.
      mockCallTool.mockImplementation(async (_params, _schema, options) => {
        options?.onprogress?.({
          progress: 0.25,
          total: 1,
          message: "starting",
        });
        options?.onprogress?.({
          progress: 0.75,
          total: 1,
          message: "almost done",
        });
        return createMCPToolCallResult([{ type: "text", text: "Result" }]);
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-progress" },
      ]);
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const events = await collectEvents(
        middleware.run(
          createRunAgentInput({ messages: [assistantMsg] }),
          agent,
        ),
      );

      const progressSnapshots = events.filter(
        (e) =>
          e.type === EventType.ACTIVITY_SNAPSHOT &&
          (e as any).activityType === MCPAppsProgressActivityType,
      );
      const progressDeltas = events.filter(
        (e) =>
          e.type === EventType.ACTIVITY_DELTA &&
          (e as any).activityType === MCPAppsProgressActivityType,
      );

      // Exactly one SNAPSHOT (the first tick), one DELTA (the second tick).
      expect(progressSnapshots.length).toBe(1);
      expect(progressDeltas.length).toBe(1);

      // Snapshot carries the initial state and stable messageId.
      const expectedMessageId = "mcp-apps-progress:tc-progress";
      expect((progressSnapshots[0] as any).messageId).toBe(expectedMessageId);
      expect((progressSnapshots[0] as any).replace).toBe(false);
      expect((progressSnapshots[0] as any).content).toMatchObject({
        progress: 0.25,
        total: 1,
        message: "starting",
        toolCallId: "tc-progress",
        toolName: "ui-tool",
      });

      // Delta updates the same activity message and only carries the
      // changed fields (`progress` + `message` here; `total` was stable).
      expect((progressDeltas[0] as any).messageId).toBe(expectedMessageId);
      const patch = (progressDeltas[0] as any).patch as Array<{
        op: string;
        path: string;
        value?: unknown;
      }>;
      expect(patch).toContainEqual({
        op: "replace",
        path: "/progress",
        value: 0.75,
      });
      expect(patch).toContainEqual({
        op: "replace",
        path: "/message",
        value: "almost done",
      });
      expect(patch.find((p) => p.path === "/total")).toBeUndefined();

      // Final widget snapshot still emitted afterwards.
      const finalSnapshot = events.find(
        (e) =>
          e.type === EventType.ACTIVITY_SNAPSHOT &&
          (e as any).activityType === MCPAppsActivityType,
      );
      expect(finalSnapshot).toBeDefined();
      expect((finalSnapshot as any).replace).toBe(true);
    });

    it("uses add/remove ops when total/message appear or disappear across ticks", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });

      mockCallTool.mockImplementation(async (_params, _schema, options) => {
        // Tick 1: progress only (no total, no message)
        options?.onprogress?.({ progress: 0.1 });
        // Tick 2: total appears, message appears
        options?.onprogress?.({
          progress: 0.5,
          total: 10,
          message: "halfway",
        });
        // Tick 3: message disappears, total stays
        options?.onprogress?.({ progress: 0.9, total: 10 });
        return createMCPToolCallResult([{ type: "text", text: "ok" }]);
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-add-remove" },
      ]);
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const events = await collectEvents(
        middleware.run(
          createRunAgentInput({ messages: [assistantMsg] }),
          agent,
        ),
      );

      const deltas = events.filter(
        (e) =>
          e.type === EventType.ACTIVITY_DELTA &&
          (e as any).activityType === MCPAppsProgressActivityType,
      );
      expect(deltas.length).toBe(2);

      // Tick 2 patch: progress replaced, total added, message added.
      const patch2 = (deltas[0] as any).patch;
      expect(patch2).toContainEqual({
        op: "replace",
        path: "/progress",
        value: 0.5,
      });
      expect(patch2).toContainEqual({ op: "add", path: "/total", value: 10 });
      expect(patch2).toContainEqual({
        op: "add",
        path: "/message",
        value: "halfway",
      });

      // Tick 3 patch: progress replaced, message removed, total stable.
      const patch3 = (deltas[1] as any).patch;
      expect(patch3).toContainEqual({
        op: "replace",
        path: "/progress",
        value: 0.9,
      });
      expect(patch3).toContainEqual({ op: "remove", path: "/message" });
      expect(patch3.find((p: any) => p.path === "/total")).toBeUndefined();

      // Initial snapshot omits absent optional fields.
      const snapshot = events.find(
        (e) =>
          e.type === EventType.ACTIVITY_SNAPSHOT &&
          (e as any).activityType === MCPAppsProgressActivityType,
      );
      expect((snapshot as any).content.total).toBeUndefined();
      expect((snapshot as any).content.message).toBeUndefined();
      expect((snapshot as any).content.progress).toBe(0.1);
    });

    it("scopes progress activity messageId per toolCallId for concurrent calls", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });

      // Each invocation emits exactly one progress tick before resolving.
      mockCallTool.mockImplementation(async (params, _schema, options) => {
        options?.onprogress?.({
          progress: 0.5,
          message: `for ${(params as any).arguments.tag}`,
        });
        return createMCPToolCallResult([{ type: "text", text: "ok" }]);
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: { tag: "a" }, id: "tc-a" },
        { name: "ui-tool", args: { tag: "b" }, id: "tc-b" },
      ]);
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const events = await collectEvents(
        middleware.run(
          createRunAgentInput({ messages: [assistantMsg] }),
          agent,
        ),
      );

      const progressSnapshots = events.filter(
        (e) =>
          e.type === EventType.ACTIVITY_SNAPSHOT &&
          (e as any).activityType === MCPAppsProgressActivityType,
      );
      const messageIds = progressSnapshots
        .map((e) => (e as any).messageId)
        .sort();
      expect(messageIds).toEqual([
        "mcp-apps-progress:tc-a",
        "mcp-apps-progress:tc-b",
      ]);
    });

    it("emits progress events before the final result event", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });

      mockCallTool.mockImplementation(async (_params, _schema, options) => {
        options?.onprogress?.({ progress: 0.5 });
        return createMCPToolCallResult([{ type: "text", text: "done" }]);
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const events = await collectEvents(
        middleware.run(
          createRunAgentInput({ messages: [assistantMsg] }),
          agent,
        ),
      );

      const progressIdx = events.findIndex(
        (e) =>
          e.type === EventType.ACTIVITY_SNAPSHOT &&
          (e as any).activityType === MCPAppsProgressActivityType,
      );
      const resultIdx = events.findIndex(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      expect(progressIdx).toBeGreaterThanOrEqual(0);
      expect(resultIdx).toBeGreaterThan(progressIdx);
    });

    it("executes pending UI tool calls in parallel", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });

      let active = 0;
      let maxActive = 0;
      mockCallTool.mockImplementation(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active--;
        return createMCPToolCallResult([{ type: "text", text: "ok" }]);
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: { i: 1 }, id: "tc-1" },
        { name: "ui-tool", args: { i: 2 }, id: "tc-2" },
        { name: "ui-tool", args: { i: 3 }, id: "tc-3" },
      ]);
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(
        middleware.run(
          createRunAgentInput({ messages: [assistantMsg] }),
          agent,
        ),
      );

      expect(maxActive).toBeGreaterThan(1);
      expect(mockCallTool).toHaveBeenCalledTimes(3);
    });

    it("reuses one MCP client across pending tool calls on the same server", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "ok" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: { i: 1 }, id: "tc-1" },
        { name: "ui-tool", args: { i: 2 }, id: "tc-2" },
        { name: "ui-tool", args: { i: 3 }, id: "tc-3" },
      ]);
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const beforeConnect = mockConnect.mock.calls.length;
      await collectEvents(
        middleware.run(
          createRunAgentInput({ messages: [assistantMsg] }),
          agent,
        ),
      );
      // 1 connect for fetchUITools + 1 connect shared across the three tool
      // executions = 2 total calls beyond the baseline.
      expect(mockConnect.mock.calls.length - beforeConnect).toBe(2);
    });

    it("isolates failures: one tool failure does not block the others", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });

      mockCallTool.mockImplementation(async (params) => {
        const args = (params as any).arguments;
        if (args?.shouldFail) {
          throw new Error("Boom");
        }
        return createMCPToolCallResult([{ type: "text", text: "ok" }]);
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: { shouldFail: true }, id: "tc-fail" },
        { name: "ui-tool", args: { shouldFail: false }, id: "tc-ok" },
      ]);
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const events = await collectEvents(
        middleware.run(
          createRunAgentInput({ messages: [assistantMsg] }),
          agent,
        ),
      );

      const results = events.filter(
        (e) => e.type === EventType.TOOL_CALL_RESULT,
      );
      expect(results.length).toBe(2);
      const byId = new Map(results.map((e) => [(e as any).toolCallId, e]));
      expect(JSON.parse((byId.get("tc-fail") as any).content).error).toBe(
        "Boom",
      );
      expect((byId.get("tc-ok") as any).content).toBe("ok");
      consoleErrorSpy.mockRestore();
    });
  });

  // =============================================================================
  // 15. Cache resilience and multi-server isolation
  // =============================================================================
  describe("MCPClientCache resilience", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("isolates clients per server: distinct connects for distinct configs", async () => {
      const serverA: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3000",
        serverId: "server-a",
      };
      const serverB: MCPClientConfig = {
        type: "http",
        url: "http://localhost:3001",
        serverId: "server-b",
      };

      // Distinct tool names so we don't trigger the collision warn path
      // and noise up unrelated stderr.
      mockListTools
        .mockResolvedValueOnce({
          tools: [createMCPToolWithUI("ui-a", "ui://a/widget")],
        })
        .mockResolvedValueOnce({
          tools: [createMCPToolWithUI("ui-b", "ui://b/widget")],
        });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "ok" }]),
      );

      const middleware = new MCPAppsMiddleware({
        mcpServers: [serverA, serverB],
      });
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-a", args: {}, id: "tc-a" },
        { name: "ui-b", args: {}, id: "tc-b" },
      ]);
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const beforeConnect = mockConnect.mock.calls.length;
      await collectEvents(
        middleware.run(
          createRunAgentInput({ messages: [assistantMsg] }),
          agent,
        ),
      );

      // 2 connects for fetchUITools (one per server, parallel) + 2 connects
      // for the run-scoped cached clients (one per server) during exec = 4
      // total. Each server gets its own cache entry, isolated from the other.
      expect(mockConnect.mock.calls.length - beforeConnect).toBe(4);
    });

    it("logs close failures with serverId/serverHash context and continues", async () => {
      const logger: Logger & {
        warn: ReturnType<typeof vi.fn>;
        error: ReturnType<typeof vi.fn>;
      } = {
        warn: vi.fn(),
        error: vi.fn(),
      };

      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });
      mockCallTool.mockResolvedValue(
        createMCPToolCallResult([{ type: "text", text: "ok" }]),
      );

      // First close (after fetchUITools) succeeds. Second close (the
      // run-scoped cached client) throws. The run must still complete and
      // the logger must receive the close failure with server context.
      mockClose
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("close blew up"));

      const middleware = new MCPAppsMiddleware({
        mcpServers: [
          { type: "http", url: "http://localhost:3000", serverId: "srv-1" },
        ],
        logger,
      });
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-1" },
      ]);
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const events = await collectEvents(
        middleware.run(
          createRunAgentInput({ messages: [assistantMsg] }),
          agent,
        ),
      );

      // Run completed with a normal RunFinished even though close threw.
      const finished = events.find((e) => e.type === EventType.RUN_FINISHED);
      expect(finished).toBeDefined();

      expect(logger.error).toHaveBeenCalledWith(
        "Failed to close MCP client",
        expect.any(Error),
        expect.objectContaining({
          serverId: "srv-1",
          serverHash: expect.any(String),
        }),
      );
    });
  });

  // =============================================================================
  // 16. fetchUITools partial-failure isolation
  // =============================================================================
  describe("fetchUITools partial failure", () => {
    it("registers surviving servers' tools when one server fails to connect", async () => {
      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const serverFail: MCPClientConfig = {
        type: "http",
        url: "http://fail:3000",
        serverId: "fail",
      };
      const serverOk1: MCPClientConfig = {
        type: "http",
        url: "http://ok1:3000",
        serverId: "ok1",
      };
      const serverOk2: MCPClientConfig = {
        type: "http",
        url: "http://ok2:3000",
        serverId: "ok2",
      };

      // The fail server's connect rejects; the other two connect cleanly.
      // The order of connect calls matches the order servers are listed
      // because Promise.allSettled creates promises in `.map` iteration
      // order, which is sequential.
      mockConnect
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValue(undefined);

      mockListTools
        .mockResolvedValueOnce({
          tools: [createMCPToolWithUI("tool-ok1", "ui://ok1")],
        })
        .mockResolvedValueOnce({
          tools: [createMCPToolWithUI("tool-ok2", "ui://ok2")],
        });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [serverFail, serverOk1, serverOk2],
      });
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      await collectEvents(middleware.run(createRunAgentInput(), agent));

      // The downstream agent should have received the surviving servers'
      // tools merged into its input.
      expect(agent.runCalls.length).toBe(1);
      const toolNames = agent.runCalls[0].tools.map((t) => t.name);
      expect(toolNames).toContain("tool-ok1");
      expect(toolNames).toContain("tool-ok2");

      consoleErrorSpy.mockRestore();
    });
  });

  // =============================================================================
  // 17. Streaming progress: no-op delta suppression
  // =============================================================================
  describe("Streaming progress no-op suppression", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    it("emits no DELTA when consecutive ticks carry identical state", async () => {
      const uiTool = createMCPToolWithUI("ui-tool", "ui://server/tool");
      mockListTools.mockResolvedValue({ tools: [uiTool] });

      mockCallTool.mockImplementation(async (_params, _schema, options) => {
        // Tick 1: SNAPSHOT
        options?.onprogress?.({ progress: 0.5, total: 1, message: "halfway" });
        // Tick 2: identical to tick 1 -> suppressed
        options?.onprogress?.({ progress: 0.5, total: 1, message: "halfway" });
        // Tick 3: progress changed -> DELTA
        options?.onprogress?.({ progress: 0.8, total: 1, message: "halfway" });
        return createMCPToolCallResult([{ type: "text", text: "ok" }]);
      });

      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const assistantMsg = createAssistantMessageWithToolCalls([
        { name: "ui-tool", args: {}, id: "tc-noop" },
      ]);
      const agent = new MockAgent([
        createRunStartedEvent(),
        createRunFinishedEvent(),
      ]);

      const events = await collectEvents(
        middleware.run(
          createRunAgentInput({ messages: [assistantMsg] }),
          agent,
        ),
      );

      const snapshots = events.filter(
        (e) =>
          e.type === EventType.ACTIVITY_SNAPSHOT &&
          (e as any).activityType === MCPAppsProgressActivityType,
      );
      const deltas = events.filter(
        (e) =>
          e.type === EventType.ACTIVITY_DELTA &&
          (e as any).activityType === MCPAppsProgressActivityType,
      );

      expect(snapshots.length).toBe(1);
      expect(deltas.length).toBe(1); // only tick 3 produces a non-empty patch
      expect((deltas[0] as any).patch).toContainEqual({
        op: "replace",
        path: "/progress",
        value: 0.8,
      });
    });
  });

  // =============================================================================
  // 18. Proxied request allowlist (expanded methods)
  // =============================================================================
  describe("Proxied request allowlist", () => {
    const httpServerConfig: MCPClientConfig = {
      type: "http",
      url: "http://localhost:3000",
    };

    function runProxied(method: string, params?: Record<string, unknown>) {
      const middleware = new MCPAppsMiddleware({
        mcpServers: [httpServerConfig],
      });
      const proxiedRequest: ProxiedMCPRequest = {
        serverHash: getServerHash(httpServerConfig),
        method,
        params,
      };
      const input = createRunAgentInput({
        forwardedProps: { __proxiedMCPRequest: proxiedRequest },
      });
      return collectEvents(middleware.run(input, new MockAgent([])));
    }

    function lastFinished(events: BaseEvent[]) {
      return events.find((e) => e.type === EventType.RUN_FINISHED) as any;
    }

    it("forwards tools/list with params to client.listTools", async () => {
      const expected = { tools: [{ name: "x" }] };
      mockListTools.mockResolvedValue(expected);

      const events = await runProxied("tools/list", { cursor: "abc" });

      expect(mockListTools).toHaveBeenCalledWith({ cursor: "abc" });
      expect(lastFinished(events).result).toEqual(expected);
    });

    it("forwards resources/list with params to client.listResources", async () => {
      const expected = { resources: [{ uri: "file:///x" }] };
      mockListResources.mockResolvedValue(expected);

      const events = await runProxied("resources/list", { cursor: "c" });

      expect(mockListResources).toHaveBeenCalledWith({ cursor: "c" });
      expect(lastFinished(events).result).toEqual(expected);
    });

    it("forwards resources/templates/list to client.listResourceTemplates", async () => {
      const expected = { resourceTemplates: [{ name: "t" }] };
      mockListResourceTemplates.mockResolvedValue(expected);

      const events = await runProxied("resources/templates/list");

      expect(mockListResourceTemplates).toHaveBeenCalled();
      expect(lastFinished(events).result).toEqual(expected);
    });

    it("forwards prompts/list to client.listPrompts", async () => {
      const expected = { prompts: [{ name: "p" }] };
      mockListPrompts.mockResolvedValue(expected);

      const events = await runProxied("prompts/list");

      expect(mockListPrompts).toHaveBeenCalled();
      expect(lastFinished(events).result).toEqual(expected);
    });

    it("forwards prompts/get with params to client.getPrompt", async () => {
      const expected = { messages: [{ role: "user" }] };
      mockGetPrompt.mockResolvedValue(expected);

      const events = await runProxied("prompts/get", {
        name: "greeting",
        arguments: { who: "world" },
      });

      expect(mockGetPrompt).toHaveBeenCalledWith({
        name: "greeting",
        arguments: { who: "world" },
      });
      expect(lastFinished(events).result).toEqual(expected);
    });

    it("rejects unlisted methods with the disallowed-method error", async () => {
      const events = await runProxied("resources/subscribe", {
        uri: "file:///x",
      });

      expect(lastFinished(events).result.error).toContain(
        "MCP method not allowed for UI proxy",
      );
    });

    it("preserves Error.message from the SDK on proxied failure", async () => {
      mockGetPrompt.mockRejectedValue(new Error("specific SDK error"));

      const events = await runProxied("prompts/get", { name: "x" });

      expect(lastFinished(events).result.error).toBe("specific SDK error");
    });
  });
});
