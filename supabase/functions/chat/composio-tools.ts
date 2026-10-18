// Composio gives Bentley hundreds more apps (Slack, Notion, Trello and so on) through one key.
// The person connects each app inside their Composio account; Bentley finds an action and runs it.
//
// Finding actions and listing connected apps run on their own. Running an action is always risky,
// because Bentley cannot know in advance what an action will change: the person approves it first.
import { defineTool, failureDetail, jsonRequest, limit, optionalText, requiredText, savedToken, shorten, ToolError } from "./tool-kit.ts";
import type { Tool, ToolContext } from "./tool-kit.ts";

const API = "https://backend.composio.dev/api/v3.1";
const MAX_ARGUMENT_CHARS = 5000;
const RECONNECT_HINT = "Ask the person to reconnect Composio in Settings → Connections.";

/* ---------- Talking to Composio ---------- */

async function composio(ctx: ToolContext, path: string, init: RequestInit = {}) {
  const key = await savedToken(ctx, "composio", "Composio");
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), "x-api-key": key },
    signal: ctx.signal,
  });
  if (response.ok) return await response.json();

  const detail = await failureDetail(response);
  console.error("Composio request failed with status", response.status);
  if (response.status === 401 || response.status === 403) throw new ToolError(`Composio rejected the saved key. ${RECONNECT_HINT}`);
  throw new ToolError(`Composio returned an error (${response.status}). ${detail}`.trim());
}

type ConnectedAccount = { id: string; user_id?: string; toolkit?: { slug?: string } };

// The person's active connected apps. Only ids and names are kept: the full record holds credentials.
async function activeAccounts(ctx: ToolContext, toolkit?: string): Promise<{ id: string; userId?: string; toolkit: string }[]> {
  const query = new URLSearchParams({ statuses: "ACTIVE", limit: "50" });
  if (toolkit) query.set("toolkit_slugs", toolkit);
  const data = await composio(ctx, `/connected_accounts?${query}`);
  const items: ConnectedAccount[] = Array.isArray(data.items) ? data.items : [];
  return items.map((item) => ({ id: item.id, userId: item.user_id, toolkit: item.toolkit?.slug ?? "unknown" }));
}

/* ---------- Reading ---------- */

type FoundTool = {
  slug: string;
  name?: string;
  description?: string;
  input_parameters?: Record<string, { type?: string; description?: string; required?: boolean }>;
};

const listApps = defineTool({
  name: "composio_list_apps",
  provider: "composio",
  description: "List the apps the person has connected inside Composio.",
  parameters: { type: "object", properties: {} },
  risky: false,
  parse: () => ({}),
  async run(_args, ctx) {
    const accounts = await activeAccounts(ctx);
    return { apps: [...new Set(accounts.map((account) => account.toolkit))] };
  },
});

const findTools = defineTool({
  name: "composio_find_actions",
  provider: "composio",
  description:
    "Search Composio for actions Bentley can run, for example 'create a Trello card'. Returns each action's name and the inputs it needs.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What you want to do." },
      app: { type: "string", description: "Optional app name to narrow the search, for example slack." },
    },
    required: ["query"],
  },
  risky: false,
  parse: (raw) => ({
    query: requiredText(raw, "query", 200),
    app: optionalText(raw, "app", 60)?.toLowerCase(),
    count: limit(raw, "max_results", 6, 10),
  }),
  async run({ query, app, count }, ctx) {
    const params = new URLSearchParams({ query, limit: String(count) });
    if (app) params.set("toolkit_slug", app);
    const data = await composio(ctx, `/tools?${params}`);
    const items: FoundTool[] = Array.isArray(data.items) ? data.items : [];
    return items.map((item) => ({
      action: item.slug,
      description: shorten(String(item.description || ""), 200),
      inputs: Object.entries(item.input_parameters || {}).map(([name, info]) => ({
        name,
        type: info.type,
        required: Boolean(info.required),
        description: shorten(String(info.description || ""), 100),
      })),
    }));
  },
});

/* ---------- Running an action (always asks first) ---------- */

const runAction = defineTool({
  name: "composio_run_action",
  provider: "composio",
  description:
    "Run one Composio action, using the exact action name and inputs from composio_find_actions. The person must approve it first.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", description: "The action name, for example SLACK_SEND_MESSAGE." },
      inputs: { type: "object", description: "The inputs the action needs." },
    },
    required: ["action"],
  },
  risky: true,
  parse: (raw) => {
    const action = requiredText(raw, "action", 100);
    if (!/^[A-Z0-9_]{3,100}$/.test(action)) throw new ToolError(`"action" must be an action name such as SLACK_SEND_MESSAGE.`);
    const inputs = raw.inputs ?? {};
    if (typeof inputs !== "object" || Array.isArray(inputs) || inputs === null) throw new ToolError(`"inputs" must be an object.`);
    if (JSON.stringify(inputs).length > MAX_ARGUMENT_CHARS) throw new ToolError(`"inputs" is too large.`);
    return { action, inputs: inputs as Record<string, unknown> };
  },
  async describe({ action, inputs }) {
    return `Run the Composio action ${action}\nWith: ${shorten(JSON.stringify(inputs, null, 1), 800)}`;
  },
  async run({ action, inputs }, ctx) {
    // Action names start with the app name, for example SLACK_SEND_MESSAGE belongs to slack.
    const toolkit = action.split("_")[0].toLowerCase();
    const [account] = await activeAccounts(ctx, toolkit);
    if (!account) {
      throw new ToolError(`No connected ${toolkit} account was found in Composio. Ask the person to connect it in their Composio account.`);
    }

    const result = await composio(
      ctx,
      `/tools/execute/${action}`,
      jsonRequest("POST", { connected_account_id: account.id, user_id: account.userId, arguments: inputs }),
    );
    if (result.successful === false) throw new ToolError(`The action failed. ${shorten(String(result.error || ""), 300)}`.trim());
    return { done: true, result: shorten(JSON.stringify(result.data ?? {}), 3000) };
  },
});

export const COMPOSIO_TOOLS: Tool[] = [listApps, findTools, runAction];
