import { Message, RunAgentInput, State } from "@ag-ui/core";

export interface AgentConfig {
  agentId?: string;
  description?: string;
  threadId?: string;
  initialMessages?: Message[];
  initialState?: State;
  debug?: boolean;
}

export interface HttpAgentConfig extends AgentConfig {
  url: string;
  /** Optional override for the connect endpoint URL. */
  connectUrl?: string;
  headers?: Record<string, string>;
}

export type RunAgentParameters = Partial<
  Pick<RunAgentInput, "runId" | "tools" | "context" | "forwardedProps">
>;
