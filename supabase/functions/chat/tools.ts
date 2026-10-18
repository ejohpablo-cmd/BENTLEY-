// The list of everything Axelvon can do. Each connection has its own file; this one joins them
// and offers the AI only the tools for the connections that are actually available.
import { COMPOSIO_TOOLS } from "./composio-tools.ts";
import { GITHUB_TOOLS } from "./github-tools.ts";
import { GOOGLE_TOOLS } from "./google-tools.ts";
import { IMAGE_TOOLS } from "./image-tools.ts";
import { MEMORY_TOOLS } from "./memory-tools.ts";
import { SUPABASE_TOOLS } from "./supabase-tools.ts";
import { WEB_TOOLS } from "./web-tools.ts";
import type { Provider, Tool } from "./tool-kit.ts";

export { ToolError } from "./tool-kit.ts";

const ALL_TOOLS: Tool[] = [...WEB_TOOLS, ...IMAGE_TOOLS, ...MEMORY_TOOLS, ...GOOGLE_TOOLS, ...GITHUB_TOOLS, ...SUPABASE_TOOLS, ...COMPOSIO_TOOLS];

export function findTool(name: string): Tool | undefined {
  return ALL_TOOLS.find((tool) => tool.name === name);
}

// The tools for the given connections, in the format the AI provider expects.
export function toolDefinitions(providers: Provider[]) {
  return ALL_TOOLS.filter((tool) => providers.includes(tool.provider)).map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}
