# Gong MCP Server

**This is a fork of https://github.com/kenazk/gong-mcp and contains new features. It may diverge over time.**

A Model Context Protocol (MCP) server that provides access to Gong's API for retrieving call recordings and transcripts. This server allows Claude to interact with Gong data through a standardized interface.

## Features

- List Gong calls with optional date range filtering
- Retrieve detailed transcripts for specific calls
  - Plain text format (default) optimized for minimal data size - 80-90% reduction
  - JSON format available when structured data with timestamps is needed
  - Optional metadata flags for entities, interactions, and trackers
- Get call details by call ID(s)
- Find calls by participant email address
- Secure authentication using Gong's API credentials
- Standardized MCP interface for easy integration with Claude
- Optimized for Claude Desktop conversation size limits

## Prerequisites

- Node.js 18 or higher
- Docker (optional, for containerized deployment)
- Gong API credentials (Access Key and Secret)

## Installation

### Local Development

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the project:
   ```bash
   npm run build
   ```

4. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```

5. Edit `.env` and replace the values in the configuration file with your Gong credentials.

THe `.env` file is ignored in the `.gitignore` and `.dockerignore` files so it won't be accidentally shared.

### Docker

Build the container:

```bash
docker build -t gong-mcp .
```

You can also use `npm run docker:build` as a shortcut.

Test the container image using environment file (recommended):

```bash
docker run -i --rm --env-file .env gong-mcp
```

Or test with individual environment variables:

```bash
docker run -i --rm  \
  -e GONG_ACCESS_KEY="your_access_key_here" \
  -e GONG_ACCESS_SECRET="your_access_secret_here" \
  gong-mcp
```

Press `CTRL-C` to stop the container.


## Configuring Claude Desktop

1. Open Claude Desktop settings and go to the **Developer** tab.
1. Press **Edit Config**.
1. Open the `claude_desktop_config.json` file in your editor.
1. Navigate to the `mcpServers` section or add it if it doesn't exist.
1. Add a new server with one of the following configurations:

### Option 1: Using Environment File (Recommended)

This keeps credentials out of the Claude Desktop config file:

```json
{
  "mcpServers": {
    "gong": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "--env-file",
        "/absolute/path/to/gong-mcp/.env",
        "gong-mcp"
      ]
    }
  }
}
```

Replace `/absolute/path/to/gong-mcp/.env` with the actual absolute path to your
`.env` file. Specify the entire path; you won't be able to use `~/` in the configuration.

### Option 2: Using Inline Environment Variables

This embeds credentials directly in the config file (not ideal:)

```json
{
  "mcpServers": {
    "gong": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e", "GONG_ACCESS_KEY=your_access_key_here",
        "-e", "GONG_ACCESS_SECRET=your_access_secret_here",
        "gong-mcp"
      ]
    }
  }
}
```

Replace `your_access_key_here` and `your_access_secret_here` with your actual Gong API credentials.

---

After configuring, save the file and restart Claude Desktop. You can then ask Claude to list Gong calls, retrieve transcripts, get call details by ID, or find calls by participant email.

## Available Tools

### list_calls

Retrieves a list of Gong calls with optional date range filtering.

```typescript
{
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
}
```

### retrieve_transcripts

Retrieves detailed transcripts for one or more call IDs. Accepts either a single call ID string or an array of call IDs.

**Output Format:** By default, transcripts are returned in plain text format optimized for minimal data size and conversation analysis. This format converts the JSON structure into a simple "Speaker: dialogue text" format that dramatically reduces data volume (80-90% reduction) and helps avoid conversation size limits in Claude Desktop.

**Format Options:**
- `format: "text"` (default) - Returns compact plain text transcripts. Recommended for most use cases including summarization, analysis, and conversation review.
- `format: "json"` - Returns structured data with timestamps and speaker IDs. Use only when you need programmatic access to timestamps or detailed structure.

**Additional Metadata:** When using `format: "json"`, you can optionally include additional data by setting flags to `true`:
- `includeEntities` - Entity extraction data (WARNING: significantly increases response size)
- `includeInteractionsSummary` - Interactions summary data (WARNING: significantly increases response size)
- `includeTrackers` - Tracker data (WARNING: significantly increases response size)

All metadata flags default to `false` to minimize data size.

```typescript
{
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
}
```

### get_calls

Retrieves detailed information for one or more Gong calls by ID(s). Accepts either a single call ID string or an array of call IDs. Handles errors gracefully by returning information about any calls that couldn't be retrieved.

```typescript
{
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
}
```

### get_calls_for_email

Finds all Gong calls where a specific email address participated.

**Important Implementation Note:** This tool uses the `/calls/extensive` endpoint which includes participant data. It works by:
1. Fetching calls from the `/calls/extensive` endpoint with date range filtering
2. Requesting party information via the `contentSelector.exposedFields.parties` parameter
3. Handling pagination automatically using cursor-based pagination to fetch all results
4. Filtering the results client-side to find calls where the email address matches
5. Returning only essential fields (id, title, scheduled, started, duration, url, direction, system, scope, media, language, parties) to keep response size minimal

**Date Range Behavior:** If no date range is specified, it defaults to the **last 7 days** to keep response sizes manageable and conversations efficient. You can provide explicit `fromDateTime` and `toDateTime` parameters to search a specific date range for historical data.

```typescript
{
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
}
```

## License

MIT License - see LICENSE file for details

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request
