// Live information from the web: searching it and reading a page.
//
// Both tools go through Tavily, a search service built for AI. The server keeps the key
// (the TAVILY_API_KEY secret) and Axelvon's own server never opens the pages itself.
import { defineTool, failureDetail, limit, optionalText, requiredText, shorten, ToolError } from "./tool-kit.ts";
import type { Tool, ToolContext } from "./tool-kit.ts";

const SEARCH_URL = "https://api.tavily.com/search";
const EXTRACT_URL = "https://api.tavily.com/extract";
const MAX_PAGE_CHARS = 8000;
const MAX_SNIPPET_CHARS = 500;

// Sends one request to Tavily. Anything other than success becomes a short ToolError.
async function tavily(ctx: ToolContext, url: string, body: Record<string, unknown>) {
  if (!ctx.tavilyKey) throw new ToolError("Web search is not set up on the server.");

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.tavilyKey}` },
    body: JSON.stringify(body),
    signal: ctx.signal,
  });
  if (!response.ok) {
    console.error("Web search request failed with status", response.status);
    const detail = await failureDetail(response);
    throw new ToolError(`The web search service returned an error (${response.status}). ${detail}`.trim());
  }
  return await response.json();
}

// Only ordinary web addresses are read.
function requiredWebUrl(raw: Record<string, unknown>): string {
  const text = requiredText(raw, "url", 2000);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new ToolError(`"url" is not a valid web address.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new ToolError(`"url" must start with http or https.`);
  return parsed.toString();
}

type SearchResult = { title?: string; url?: string; content?: string };

const webSearch = defineTool({
  name: "web_search",
  provider: "web",
  description:
    "Search the web for current information: news, prices, scores, facts that may have changed, or anything you are unsure of. Returns a short answer plus sources.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "What to search for." },
      topic: { type: "string", enum: ["general", "news"], description: "Use news for recent events. Default general." },
      max_results: { type: "number", description: "How many results, 1 to 8. Default 5." },
    },
    required: ["query"],
  },
  risky: false,
  parse: (raw) => {
    const topic = optionalText(raw, "topic", 16);
    if (topic !== undefined && topic !== "general" && topic !== "news") throw new ToolError(`"topic" must be general or news.`);
    return { query: requiredText(raw, "query", 400), topic: topic ?? "general", count: limit(raw, "max_results", 5, 8) };
  },
  async run({ query, topic, count }, ctx) {
    const data = await tavily(ctx, SEARCH_URL, {
      query,
      topic,
      max_results: count,
      search_depth: "basic",
      include_answer: true,
    });
    const results: SearchResult[] = Array.isArray(data.results) ? data.results : [];
    return {
      answer: typeof data.answer === "string" ? shorten(data.answer, 1500) : undefined,
      results: results.map((item) => ({
        title: item.title,
        url: item.url,
        snippet: shorten(String(item.content || ""), MAX_SNIPPET_CHARS),
      })),
    };
  },
});

const webFetch = defineTool({
  name: "web_fetch",
  provider: "web",
  description: "Read the text of one web page, for example a result from web_search or a link the person gave you.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "The full web address, starting with https://." } },
    required: ["url"],
  },
  risky: false,
  parse: (raw) => ({ url: requiredWebUrl(raw) }),
  async run({ url }, ctx) {
    const data = await tavily(ctx, EXTRACT_URL, { urls: [url], format: "text" });
    const page: { raw_content?: string } | undefined = Array.isArray(data.results) ? data.results[0] : undefined;
    if (!page || !page.raw_content) throw new ToolError("That page could not be read.");
    return { url, content: shorten(page.raw_content, MAX_PAGE_CHARS) };
  },
});

export const WEB_TOOLS: Tool[] = [webSearch, webFetch];
