# Oksskolten Spec — Chat

> [Back to Overview](./01_overview.md)

## Overview

Interactive chat feature. Users can search articles, analyze content, and get recommendations using natural language.

## Motivation

A core feature of Oksskolten. Enables natural-language interaction with the article database — ask questions about specific articles, perform cross-feed search, get reading recommendations, and trigger actions (summarize, translate, bookmark) through conversation.

## Design

### Architecture

Tools are centralized in an MCP server, and four backend types share a common toolset.

```
┌──────────────────────────────────────────────────────────────────┐
│  Docker Container                                                │
│                                                                  │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────────┐      │
│  │ Fastify  │───▶│ ChatService  │───▶│    MCP Server     │      │
│  │ API      │    │ (adapter)    │    │ (shared tool layer)│      │
│  └──────────┘    └──────┬───────┘    └─────────┬─────────┘      │
│                         │                      │                 │
│         ┌───────────────┼───────────────┐      │                 │
│         ▼               ▼               ▼      ▼                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐          │
│  │Anthropic │  │  Gemini  │  │  OpenAI  │  │ SQLite │          │
│  │ Adapter  │  │ Adapter  │  │ Adapter  │  │        │          │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┘          │
│       │              │              │                             │
│  ┌────────────────┐  │              │                             │
│  │ ClaudeCodeAdpt │  │              │                             │
│  └───────┬────────┘  │              │                             │
│          │           │              │                             │
└──────────┼───────────┼──────────────┼─────────────────────────────┘
           ▼           ▼              ▼
   Anthropic API   Google AI API   OpenAI API
```

| Backend | Communication Path | Notes |
|---|---|---|
| **Anthropic API** (default) | Fastify → Anthropic API (MCP tools converted to tool_use) | SSE delivery via `anthropic.messages.stream()` |
| **Google Gemini** | Fastify → Google GenAI API (MCP tools converted to function calling) | Supports Gemini 2.5 Flash / Pro |
| **OpenAI** | Fastify → OpenAI API (MCP tools converted to tool calling) | Supports GPT-5.2 / GPT-4.1 etc. |
| **Claude Code** | Fastify → `claude -p` subprocess (MCP server connected via stdio) | Tool logs restored from temporary JSONL file |

Backend selection can be switched from the settings UI (stored in DB as `ai.chat_provider`).

### File Structure

```
server/chat/
├── adapter.ts                 # Router: backend selection + runChatTurn()
├── adapter-anthropic.ts       # Anthropic API adapter
├── adapter-gemini.ts          # Google Gemini API adapter
├── adapter-openai.ts          # OpenAI API adapter
├── adapter-claude-code.ts     # Claude Code adapter
├── history.ts                 # Conversation history normalization/repair
├── mcp-server.ts              # MCP server (stdio transport)
└── tools.ts                   # Tool definitions (ToolDef neutral format)
```

### MCP Tools

Tool definitions are managed in a neutral `ToolDef` format in `server/chat/tools.ts` and converted to each provider's specific format via `toAnthropicTools()`, `toOpenAITools()`, and `toGeminiTools()`.

| Tool Name | Description | Input |
|---|---|---|
| `search_articles` | Search articles (hybrid semantic + keyword search when available with keyword fallback; feed, category, date range, unread/liked/bookmarked) | `{ query?, feed_id?, category_id?, unread?, liked?, bookmarked?, since?, until?, limit? }` |
| `get_article` | Get article details (including full_text, full_text_ja) | `{ article_id }` |
| `get_similar_articles` | Search for articles similar to a given article via Meilisearch | `{ article_id, limit? }` |
| `get_user_preferences` | Get user reading preferences (top feeds, categories, recent likes/bookmarks, per-category read rate, ignored feeds) | `{}` |
| `get_recent_activity` | Get user's recent activity in chronological order (read/liked/bookmarked) | `{ type?, limit? }` |
| `get_feeds` | Get feed list (with article count and unread count) | `{}` |
| `get_categories` | Get category list | `{}` |
| `get_reading_stats` | Get reading statistics | `{ since?, until? }` |
| `mark_as_read` | Mark an article as seen | `{ article_id }` |
| `toggle_like` | Toggle an article's like status | `{ article_id }` |
| `toggle_bookmark` | Toggle an article's bookmark status | `{ article_id }` |
| `summarize_article` | Summarize an article (checks cache before execution) | `{ article_id }` |
| `translate_article` | Translate an article (checks cache before execution) | `{ article_id }` |

The MCP server (`server/chat/mcp-server.ts`) starts with stdio transport when executed directly, and is connected to by Claude Code.

### Using the MCP Server with Claude Code

The MCP server can be used directly from Claude Code, giving you the same chat experience as the web UI. The data directory resolves in this order:

1. `DATA_DIR` environment variable
2. `./data` (project checkout or Docker container)
3. `~/.oksskolten/data/` (standalone fallback)

#### Option 1: Local development (Node.js required)

The repository includes `.mcp.json`, so cloning the repo and running `npm install` is all that's needed. Claude Code will automatically discover and connect to the MCP server.

```json
// .mcp.json (included in repository)
{
  "mcpServers": {
    "oksskolten": {
      "command": "npx",
      "args": ["tsx", "server/chat/mcp-server.ts"]
    }
  }
}
```

#### Option 2: Docker one-liner (no Node.js required)

Install the MCP server globally with a single command:

```bash
claude mcp add --scope user --transport stdio oksskolten \
  -- docker run -i --rm -v ~/.oksskolten/data:/app/data babarot/oksskolten \
  npx tsx server/chat/mcp-server.ts
```

This makes the RSS reader tools available from any project. Data is stored in `~/.oksskolten/data/`.

Alternatively, add the following to your Claude Code MCP settings (`~/.claude.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "oksskolten": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-v", "~/.oksskolten/data:/app/data",
        "babarot/oksskolten",
        "npx", "tsx", "server/chat/mcp-server.ts"
      ]
    }
  }
}
```

#### Option 3: SSH into production server

When the app is running via `docker compose up` in production with `DATA_DIR=$HOME/.oksskolten/data` in `.env`, you can SSH into the server and run `claude` to query articles through the MCP server. The MCP server reads the same `~/.oksskolten/data/rss.db` that the Docker container writes to (SQLite WAL mode allows concurrent readers).

Setup on the production server:

```bash
# Install the MCP server (run once)
claude mcp add --scope user --transport stdio oksskolten \
  -- docker run -i --rm -v ~/.oksskolten/data:/app/data babarot/oksskolten \
  npx tsx server/chat/mcp-server.ts
```

Then from any directory:

```bash
ssh prod-server
claude  # MCP tools are available immediately
```

#### Option 4: Local Claude Code → remote production server

Connect your local Claude Code to a production server's database without SSH-ing in. This wraps SSH as a stdio transport — the remote Docker container's stdin/stdout becomes the MCP channel.

```bash
claude mcp add --scope user --transport stdio oksskolten \
  -- ssh prod-server docker run -i --rm \
  -v ~/.oksskolten/data:/app/data babarot/oksskolten \
  npx tsx server/chat/mcp-server.ts
```

Requires SSH key authentication (password prompts break stdio).

### Anthropic API Adapter

`server/chat/adapter-anthropic.ts`. Streams via `anthropic.messages.stream()` and executes up to 10 rounds of tool loops.

- Collects tool results and loops back
- SSE events: `text_delta`, `tool_use_start`, `tool_use_end`, `done`, `error`
- Messages are saved to DB in Anthropic `MessageParam` format

### Claude Code Adapter

`server/chat/adapter-claude-code.ts`. Launches `claude -p` as a subprocess and receives output via `--output-format stream-json`.

- Conversation history is built as a text prompt (`buildPrompt()`)
- MCP server is connected via stdio (MCP config passed as JSON in CLI arguments)
- Tool execution logs are read from a temporary JSONL file and restored as `tool_use` / `tool_result` blocks
- 90-second timeout (SIGKILL on expiry)

### Search Architecture

The `search_articles` tool combines Meilisearch full-text search with structured filters. When semantic search is configured and healthy it runs as hybrid semantic + keyword search (title+summary embeddings) with an automatic keyword fallback; see [86_feature_semantic_search.md](./86_feature_semantic_search.md).

```
User: "What was that Cloudflare article I read last week?"
                │
                ▼
┌──────────────────────────────┐
│  LLM (Claude)                │
│  Natural language → structured│
│  query decomposition          │
└──────────┬───────────────────┘
           ▼
┌───────────────────────────────────────┐
│  search_articles tool                 │
│  1. With query → Meilisearch FTS      │
│     - feed_id/category_id/since/until │
│       → Meilisearch filter            │
│     - unread/liked/bookmarked         │
│       → SQLite post-filter            │
│  2. Without query → SQLite WHERE      │
└───────────────────────────────────────┘
```

**Meilisearch search**: Searches across `title`, `full_text`, and `full_text_ja` with typo-tolerant, relevance-ranked full-text search. Falls back to SQLite LIKE when the search index is not built.

### DB Schema

See [10_schema.md](./10_schema.md) for the `conversations` / `chat_messages` schema.

The `content` column stores Anthropic API `messages` format as-is in JSON (including text, `tool_use`, and `tool_result`). Messages read from DB can be passed directly to the Anthropic API to resume a conversation.

| Case | `article_id` | `title` |
|---|---|---|
| Normal chat | `NULL` | Auto-generated from the first message |
| In-article chat | Article ID | Article title as initial value |

### API Endpoints

#### `POST /api/chat`

Send a chat message and return the response as an SSE stream.

```
Request:
  { "message": "...", "conversation_id?": "uuid", "article_id?": 123 }

Response: SSE stream
  data: { "type": "conversation_id", "conversation_id": "uuid" }
  data: { "type": "text_delta", "text": "This week's" }
  data: { "type": "tool_use_start", "name": "search_articles" }
  data: { "type": "tool_use_end", "name": "search_articles" }
  data: { "type": "done" }
```

Processing flow:
1. If no `conversation_id`, create a new conversation (generate UUID)
2. Retrieve past messages from DB and repair conversation history consistency
3. Execute a chat turn with the selected backend (streaming via SSE)
4. Save user message and assistant response to `chat_messages`
5. Auto-generate conversation title from the first message

#### `GET /api/chat/conversations`

Get conversation list. Can filter by in-article chats with `?article_id=123`.

#### `GET /api/chat/:id/messages`

Get message list for a conversation (filters out `tool_use` / `tool_result` for display).

#### `DELETE /api/chat/:id`

Delete a conversation and its messages (`ON DELETE CASCADE`).

#### `GET /api/chat/suggestions`

Get suggestions to start a conversation. Dynamically generated based on time of day (morning/afternoon/evening), unread count, and reading preferences.

```json
// Response: 200
{
  "suggestions": [
    { "key": "suggestion.morning.newArticles" },
    { "key": "suggestion.unreadMany", "params": { "count": 55 } },
    { "key": "suggestion.topCategory", "params": { "category": "Tech" } }
  ]
}
```

`key` is an i18n key. The frontend converts it to display text via `t()`.

#### `GET /api/chat/claude-code-status`

Check Claude Code login status. Returns `{ loggedIn, email?, plan? }`.

#### `GET /api/settings/api-keys/:provider`

Check API key configuration status for a provider (`anthropic`, `gemini`, `openai`, `google-translate`). Returns `{ configured: boolean }`.

#### `POST /api/settings/api-keys/:provider`

Save or delete a provider's API key. `{ apiKey?: string }` (empty to delete).

#### `GET /api/settings/google-translate/usage`

Return monthly character usage for Google Translate. `{ month: "2026-03", chars: 12345 }`.

### Frontend

#### ChatPanel Component

Shared between Home chat and in-article chat.

```typescript
interface ChatPanelProps {
  variant: 'full' | 'inline'
  articleId?: number
  conversationId?: string
  onConversationCreated?: (id: string) => void
}
```

| variant | Usage | Display |
|---|---|---|
| `full` | For ChatPage | Full height |
| `inline` | For in-article Callout | Max 400px, expandable via portal (close with Esc) |

- `useChat()` hook manages messages, streaming state, and conversation ID
- Enter to send, Shift+Enter for newline
- Displays tool name during tool execution
- In-article chat auto-loads existing conversation by `article_id`

#### ChatPage (`/chat`)

Conversation list in the left sidebar, `ChatPanel` (variant=`full`) on the right.

- Create, select, and delete conversations
- Routing via `/chat/:conversationId`
- Conversation list with date display

#### ChatFab (Floating Chat UI)

The `ChatFab` component displays a floating button at the bottom-right of the article detail screen.

- Click to open `ChatPanel` (variant=`inline`) inline
- Shows a badge icon when the article has an existing conversation
- On desktop, auto-opens the panel when an existing conversation exists
- State is preserved when toggling panel visibility

#### In-Article Chat

`ChatFab` is placed in the `ArticleDetail` component. When an article has an existing conversation, the chat panel opens automatically. The system prompt includes the article title and summary before being sent to the LLM.

#### Settings Page

AI and translation settings section (`/settings/integration` tab):

**Per-task settings**:
- **Chat**: Select provider (Anthropic / Gemini / OpenAI / Claude Code) and model
- **Summary**: Provider/model can be selected independently from chat
- **Translation**: Switch between LLM provider and translation service (Google Translate) modes. Model selection is hidden when Google Translate is selected

**API key management**:
- LLM providers: Set/delete keys for Anthropic / Gemini / OpenAI + configuration status indicator
- Translation service: Google Translate key settings + notes on v2/v3 differences and free tier + monthly character usage display

Settings are persisted in DB as `chat.provider`, `chat.model`, `summary.provider`, `summary.model`, `translate.provider`, `translate.model`. API keys are stored as `api_key.anthropic`, `api_key.gemini`, `api_key.openai`, `api_key.google_translate`.
