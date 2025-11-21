#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import axios from 'axios';
import dotenv from 'dotenv';
import crypto from 'crypto';

// Redirect all console output to stderr
const originalConsole = { ...console };
console.log = (...args) => originalConsole.error(...args);
console.info = (...args) => originalConsole.error(...args);
console.warn = (...args) => originalConsole.error(...args);

dotenv.config();

const GONG_API_URL = 'https://api.gong.io/v2';
const GONG_ACCESS_KEY = process.env.GONG_ACCESS_KEY;
const GONG_ACCESS_SECRET = process.env.GONG_ACCESS_SECRET;

// Check for required environment variables
if (!GONG_ACCESS_KEY || !GONG_ACCESS_SECRET) {
  console.error("Error: GONG_ACCESS_KEY and GONG_ACCESS_SECRET environment variables are required");
  process.exit(1);
}

// Type definitions
interface GongParty {
  id?: string;
  emailAddress?: string;
  name?: string;
  title?: string;
  speakerId?: string;
  affiliation?: string;
  methods?: string[];
}

interface GongCall {
  id: string;
  title: string;
  scheduled?: string;
  started?: string;
  duration?: number;
  direction?: string;
  system?: string;
  scope?: string;
  media?: string;
  language?: string;
  url?: string;
  parties?: GongParty[];
}

interface GongTranscript {
  speakerId: string;
  topic?: string;
  sentences: Array<{
    start: number;
    text: string;
  }>;
}

interface GongListCallsResponse {
  calls: GongCall[];
}

interface GongExtensiveCallsResponse {
  requestId: string;
  records: {
    totalRecords: number;
    currentPageSize: number;
    currentPageNumber: number;
    cursor?: string;
  };
  calls: Array<{
    metaData: GongCall;
    parties?: GongParty[];
    [key: string]: any;
  }>;
}

interface GongRetrieveTranscriptsResponse {
  requestId: string;
  records: {
    totalRecords: number;
    currentPageSize: number;
    currentPageNumber: number;
  };
  callTranscripts: Array<{
    callId: string;
    transcript: GongTranscript[];
  }>;
}

interface GongListCallsArgs {
  [key: string]: string | undefined;
  fromDateTime?: string;
  toDateTime?: string;
}

interface GongRetrieveTranscriptsArgs {
  callIds: string | string[];
  format?: "text" | "json";
  includeEntities?: boolean;
  includeInteractionsSummary?: boolean;
  includeTrackers?: boolean;
}

interface GongGetCallsArgs {
  ids: string | string[];
}

interface GongGetCallsForEmailArgs {
  emailAddress: string;
  fromDateTime?: string;
  toDateTime?: string;
}

interface GongCallsWithMissing {
  calls: GongCall[];
  missing: Array<{
    id: string;
    reason: string;
  }>;
  summary: string;
}

type GongCallsResult = GongCall | GongCall[] | GongCallsWithMissing;

// Helper function to convert transcript JSON to plain text format
function formatTranscriptAsText(response: GongRetrieveTranscriptsResponse): string {
  const sections: string[] = [];

  for (const callTranscript of response.callTranscripts) {
    sections.push(`=== Call ID: ${callTranscript.callId} ===\n`);

    for (const segment of callTranscript.transcript) {
      // Use shortened speaker ID for identification
      const speakerLabel = `Speaker ${segment.speakerId.slice(0, 8)}`;
      const text = segment.sentences.map(s => s.text).join(' ');
      sections.push(`${speakerLabel}: ${text}\n`);
    }

    sections.push('\n');
  }

  return sections.join('');
}

// Gong API Client
class GongClient {
  private accessKey: string;
  private accessSecret: string;

  constructor(accessKey: string, accessSecret: string) {
    this.accessKey = accessKey;
    this.accessSecret = accessSecret;
  }

  private async generateSignature(method: string, path: string, timestamp: string, params?: unknown): Promise<string> {
    const stringToSign = `${method}\n${path}\n${timestamp}\n${params ? JSON.stringify(params) : ''}`;
    const encoder = new TextEncoder();
    const keyData = encoder.encode(this.accessSecret);
    const messageData = encoder.encode(stringToSign);

    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign(
      'HMAC',
      cryptoKey,
      messageData
    );

    return btoa(String.fromCharCode(...new Uint8Array(signature)));
  }

  private async request<T>(method: string, path: string, params?: Record<string, string | undefined>, data?: Record<string, unknown>): Promise<T> {
    const timestamp = new Date().toISOString();
    const url = `${GONG_API_URL}${path}`;

    const response = await axios({
      method,
      url,
      params,
      data,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${Buffer.from(`${this.accessKey}:${this.accessSecret}`).toString('base64')}`,
        'X-Gong-AccessKey': this.accessKey,
        'X-Gong-Timestamp': timestamp,
        'X-Gong-Signature': await this.generateSignature(method, path, timestamp, data || params)
      }
    });

    return response.data as T;
  }

  async listCalls(fromDateTime?: string, toDateTime?: string): Promise<GongListCallsResponse> {
    const params: GongListCallsArgs = {};
    if (fromDateTime) params.fromDateTime = fromDateTime;
    if (toDateTime) params.toDateTime = toDateTime;

    return this.request<GongListCallsResponse>('GET', '/calls', params);
  }

  async retrieveTranscripts(
    callIds: string | string[],
    options?: {
      includeEntities?: boolean;
      includeInteractionsSummary?: boolean;
      includeTrackers?: boolean;
    }
  ): Promise<GongRetrieveTranscriptsResponse> {
    const idsArray = typeof callIds === 'string' ? [callIds] : callIds;
    return this.request<GongRetrieveTranscriptsResponse>('POST', '/calls/transcript', undefined, {
      filter: {
        callIds: idsArray,
        includeEntities: options?.includeEntities ?? false,
        includeInteractionsSummary: options?.includeInteractionsSummary ?? false,
        includeTrackers: options?.includeTrackers ?? false
      }
    });
  }

  async getCalls(ids: string | string[]): Promise<GongCallsResult> {
    if (typeof ids === 'string') {
      try {
        return await this.request<GongCall>('GET', `/calls/${ids}`);
      } catch (error: any) {
        // Handle error gracefully for single calls too
        const statusCode = error?.response?.status || error?.status;
        let reason = 'Unknown error';

        if (statusCode === 404) {
          reason = 'Call not found or not accessible (may be scheduled/incomplete)';
        } else if (statusCode === 403) {
          reason = 'Access denied';
        } else if (statusCode === 400) {
          reason = 'Invalid call ID format';
        } else {
          reason = error instanceof Error ? error.message : String(error);
        }

        // Return structured error for single calls
        return {
          calls: [],
          missing: [{ id: ids, reason }],
          summary: `Retrieved 0 calls, 1 call missing`
        };
      }
    }

    const results: GongCall[] = [];
    const missing: Array<{id: string, reason: string}> = [];

    // Fetch calls sequentially to avoid rate limiting issues
    for (const id of ids) {
      try {
        const call = await this.request<GongCall>('GET', `/calls/${id}`);
        results.push(call);
      } catch (error: any) {
        console.error(`Failed to fetch call ${id}:`, error);

        // Handle different error types gracefully
        const statusCode = error?.response?.status || error?.status;
        let reason = 'Unknown error';

        if (statusCode === 404) {
          reason = 'Call not found or not accessible (may be scheduled/incomplete)';
        } else if (statusCode === 403) {
          reason = 'Access denied';
        } else if (statusCode === 400) {
          reason = 'Invalid call ID format';
        } else {
          reason = error instanceof Error ? error.message : String(error);
        }

        missing.push({ id, reason });
      }
    }

    // Return results with information about missing calls
    if (missing.length > 0) {
      return {
        calls: results,
        missing: missing,
        summary: `Retrieved ${results.length} calls, ${missing.length} calls missing`
      };
    }

    return results;
  }

  async getCallsForEmail(emailAddress: string, fromDateTime?: string, toDateTime?: string): Promise<GongCall[]> {
    // Use /calls/extensive endpoint which includes party information
    // Default to last 7 days if no date range provided (keep response size manageable)
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const effectiveFromDateTime = fromDateTime || sevenDaysAgo.toISOString();
    const effectiveToDateTime = toDateTime || now.toISOString();

    const normalizedEmail = emailAddress.toLowerCase();
    const matchingCalls: GongCall[] = [];
    let cursor: string | undefined = undefined;

    // Fetch all pages using cursor pagination
    do {
      const requestBody: any = {
        filter: {
          fromDateTime: effectiveFromDateTime,
          toDateTime: effectiveToDateTime
        },
        contentSelector: {
          exposedFields: {
            parties: true
          }
        }
      };

      // Add cursor if we have one (for subsequent pages)
      if (cursor) {
        requestBody.cursor = cursor;
      }

      const response = await this.request<GongExtensiveCallsResponse>('POST', '/calls/extensive', undefined, requestBody);

      // Filter calls by email address and transform to GongCall format
      for (const callData of response.calls) {
        if (!callData.parties || callData.parties.length === 0) {
          continue;
        }

        const hasMatch = callData.parties.some(party =>
          party.emailAddress && party.emailAddress.toLowerCase() === normalizedEmail
        );

        if (hasMatch) {
          // Return only essential fields to keep response size minimal
          const metadata = callData.metaData;
          matchingCalls.push({
            id: metadata.id,
            title: metadata.title,
            scheduled: metadata.scheduled,
            started: metadata.started,
            duration: metadata.duration,
            url: metadata.url,
            direction: metadata.direction,
            system: metadata.system,
            scope: metadata.scope,
            media: metadata.media,
            language: metadata.language,
            parties: callData.parties
          });
        }
      }

      // Update cursor for next iteration
      cursor = response.records.cursor;

    } while (cursor); // Continue while there are more pages

    return matchingCalls;
  }
}

const gongClient = new GongClient(GONG_ACCESS_KEY, GONG_ACCESS_SECRET);

// Tool definitions
const LIST_CALLS_TOOL: Tool = {
  name: "list_calls",
  description: "List Gong calls with optional date range filtering. Returns call details including ID, title, start/end times, participants, and duration.",
  inputSchema: {
    type: "object",
    properties: {
      fromDateTime: {
        type: "string",
        description: "Start date/time in ISO format (e.g. 2024-03-01T00:00:00Z)"
      },
      toDateTime: {
        type: "string",
        description: "End date/time in ISO format (e.g. 2024-03-31T23:59:59Z)"
      }
    }
  }
};

const RETRIEVE_TRANSCRIPTS_TOOL: Tool = {
  name: "retrieve_transcripts",
  description: "Retrieve transcripts for one or more call IDs. Returns transcripts in plain text format by default to minimize data size and optimize for conversation analysis. Use 'json' format only when you need structured data with timestamps. Accepts either a single call ID or an array of call IDs.",
  inputSchema: {
    type: "object",
    properties: {
      callIds: {
        oneOf: [
          {
            type: "string",
            description: "A single Gong call ID to retrieve transcript for"
          },
          {
            type: "array",
            items: { type: "string" },
            description: "Array of Gong call IDs to retrieve transcripts for"
          }
        ],
        description: "Either a single call ID string or an array of call ID strings"
      },
      format: {
        type: "string",
        enum: ["text", "json"],
        description: "Output format. 'text' (default) returns compact plain text transcripts optimized for conversation analysis and summarization. 'json' returns structured data with timestamps and speaker IDs for programmatic processing. Use 'text' for most use cases."
      },
      includeEntities: {
        type: "boolean",
        description: "Include entity extraction data (only applies to 'json' format, WARNING: significantly increases response size). Defaults to false."
      },
      includeInteractionsSummary: {
        type: "boolean",
        description: "Include interactions summary data (only applies to 'json' format, WARNING: significantly increases response size). Defaults to false."
      },
      includeTrackers: {
        type: "boolean",
        description: "Include tracker data (only applies to 'json' format, WARNING: significantly increases response size). Defaults to false."
      }
    },
    required: ["callIds"]
  }
};

const GET_CALLS_TOOL: Tool = {
  name: "get_calls",
  description: "Retrieve details for one or more Gong calls by ID(s). Returns call metadata including title, participants, duration, and other call details. Accepts either a single call ID or an array of call IDs.",
  inputSchema: {
    type: "object",
    properties: {
      ids: {
        oneOf: [
          {
            type: "string",
            description: "A single Gong call ID to retrieve"
          },
          {
            type: "array",
            items: { type: "string" },
            description: "Array of Gong call IDs to retrieve"
          }
        ],
        description: "Either a single call ID string or an array of call ID strings"
      }
    },
    required: ["ids"]
  }
};

const GET_CALLS_FOR_EMAIL_TOOL: Tool = {
  name: "get_calls_for_email",
  description: "Retrieve Gong calls where a specific email address participated, with optional date range filtering. Returns essential call details including title, participants, duration, and URL. Uses the /calls/extensive API endpoint with date range filtering and filters results client-side for the email address. Defaults to searching the last 7 days if no date range is provided.",
  inputSchema: {
    type: "object",
    properties: {
      emailAddress: {
        type: "string",
        description: "The email address to retrieve associated calls for"
      },
      fromDateTime: {
        type: "string",
        description: "Start date/time in ISO format (e.g. 2024-03-01T00:00:00Z)"
      },
      toDateTime: {
        type: "string",
        description: "End date/time in ISO format (e.g. 2024-03-31T23:59:59Z)"
      }
    },
    required: ["emailAddress"]
  }
};

// Server implementation
const server = new Server(
  {
    name: "example-servers/gong",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Type guards
function isGongListCallsArgs(args: unknown): args is GongListCallsArgs {
  return (
    typeof args === "object" &&
    args !== null &&
    (!("fromDateTime" in args) || typeof (args as GongListCallsArgs).fromDateTime === "string") &&
    (!("toDateTime" in args) || typeof (args as GongListCallsArgs).toDateTime === "string")
  );
}

function isGongRetrieveTranscriptsArgs(args: unknown): args is GongRetrieveTranscriptsArgs {
  if (typeof args !== "object" || args === null || !("callIds" in args)) {
    return false;
  }

  const argsWithCallIds = args as { callIds: unknown };
  let callIds = argsWithCallIds.callIds;

  // Handle case where Claude sends JSON-encoded strings
  if (typeof callIds === "string") {
    try {
      const parsed = JSON.parse(callIds);
      if (Array.isArray(parsed)) {
        callIds = parsed;
        argsWithCallIds.callIds = callIds; // Update the original args
      }
    } catch {
      // If parsing fails, treat as regular string
    }
  }

  return (
    typeof callIds === "string" ||
    (Array.isArray(callIds) && callIds.every((id: unknown) => typeof id === "string"))
  );
}

function isGongGetCallsArgs(args: unknown): args is GongGetCallsArgs {
  if (typeof args !== "object" || args === null || !("ids" in args)) {
    return false;
  }

  const argsWithIds = args as { ids: unknown };
  let ids = argsWithIds.ids;

  // Handle case where Claude sends JSON-encoded strings
  if (typeof ids === "string") {
    try {
      const parsed = JSON.parse(ids);
      if (Array.isArray(parsed)) {
        ids = parsed;
        argsWithIds.ids = ids; // Update the original args
      }
    } catch {
      // If parsing fails, treat as regular string
    }
  }

  return (
    typeof ids === "string" ||
    (Array.isArray(ids) && ids.every((id: unknown) => typeof id === "string"))
  );
}

function isGongGetCallsForEmailArgs(args: unknown): args is GongGetCallsForEmailArgs {
  return (
    typeof args === "object" &&
    args !== null &&
    "emailAddress" in args &&
    typeof (args as GongGetCallsForEmailArgs).emailAddress === "string" &&
    (!("fromDateTime" in args) || typeof (args as GongGetCallsForEmailArgs).fromDateTime === "string") &&
    (!("toDateTime" in args) || typeof (args as GongGetCallsForEmailArgs).toDateTime === "string")
  );
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [LIST_CALLS_TOOL, RETRIEVE_TRANSCRIPTS_TOOL, GET_CALLS_TOOL, GET_CALLS_FOR_EMAIL_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request: { params: { name: string; arguments?: unknown } }) => {
  try {
    const { name, arguments: args } = request.params;

    if (!args) {
      throw new Error("No arguments provided");
    }

    switch (name) {
      case "list_calls": {
        if (!isGongListCallsArgs(args)) {
          throw new Error("Invalid arguments for list_calls");
        }
        const { fromDateTime, toDateTime } = args;
        const response = await gongClient.listCalls(fromDateTime, toDateTime);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(response)
          }],
          isError: false,
        };
      }

      case "retrieve_transcripts": {
        if (!isGongRetrieveTranscriptsArgs(args)) {
          throw new Error("Invalid arguments for retrieve_transcripts");
        }
        const { callIds, format = "text", includeEntities, includeInteractionsSummary, includeTrackers } = args;
        const response = await gongClient.retrieveTranscripts(callIds, {
          includeEntities,
          includeInteractionsSummary,
          includeTrackers
        });

        // Format response based on requested format
        const text = format === "text"
          ? formatTranscriptAsText(response)
          : JSON.stringify(response);

        return {
          content: [{
            type: "text",
            text
          }],
          isError: false,
        };
      }

      case "get_calls": {
        if (!isGongGetCallsArgs(args)) {
          throw new Error("Invalid arguments for get_calls");
        }
        const { ids } = args;
        const response = await gongClient.getCalls(ids);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(response)
          }],
          isError: false,
        };
      }

      case "get_calls_for_email": {
        if (!isGongGetCallsForEmailArgs(args)) {
          throw new Error("Invalid arguments for get_calls_for_email");
        }
        const { emailAddress, fromDateTime, toDateTime } = args;
        const response = await gongClient.getCallsForEmail(emailAddress, fromDateTime, toDateTime);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(response)
          }],
          isError: false,
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
