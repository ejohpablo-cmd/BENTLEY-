// The things Bentley can do with the person's Supabase projects, using the access token they saved.
//
// Listing projects, tables and functions and reading a table's rows run on their own.
// Running SQL is risky: the person always sees the exact SQL and approves it first.
// Bentley's own saved connection tokens can never be read or changed through these tools.
import { defineTool, failureDetail, jsonRequest, limit, optionalText, requiredText, savedToken, shorten, ToolError } from "./tool-kit.ts";
import type { Args, Tool, ToolContext } from "./tool-kit.ts";

const API = "https://api.supabase.com/v1";
const MAX_ROWS = 50;
const RECONNECT_HINT = "Ask the person to reconnect Supabase in Settings → Connections.";

/* ---------- Talking to Supabase ---------- */

async function supabaseApi(ctx: ToolContext, path: string, init: RequestInit = {}) {
  const token = await savedToken(ctx, "supabase", "Supabase");
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    signal: ctx.signal,
  });
  if (response.ok) return await response.json();

  const detail = await failureDetail(response);
  console.error("Supabase request failed with status", response.status);
  if (response.status === 401) throw new ToolError(`Supabase rejected the saved token. ${RECONNECT_HINT}`);
  if (response.status === 403) throw new ToolError(`Supabase refused the request. ${detail}`.trim());
  if (response.status === 404) throw new ToolError("Supabase could not find that project.");
  throw new ToolError(`Supabase returned an error (${response.status}). ${detail}`.trim());
}

async function runSql(ctx: ToolContext, project: string, sql: string) {
  return await supabaseApi(ctx, `/projects/${project}/database/query`, jsonRequest("POST", { query: sql }));
}

/* ---------- Checking the AI's input ---------- */

function requiredProject(args: Args): string {
  const project = requiredText(args, "project", 40);
  if (!/^[a-z0-9]{10,30}$/.test(project)) throw new ToolError(`"project" must be a project id from supabase_list_projects.`);
  return project;
}

// Table and schema names: plain letters, numbers and underscores only, so they are safe to quote.
function identifier(args: Args, key: string, fallback?: string): string {
  const value = optionalText(args, key, 63) ?? fallback;
  if (!value) throw new ToolError(`"${key}" is required.`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new ToolError(`"${key}" is not a valid name.`);
  return value;
}

// Bentley's saved tokens live in this table and must never pass through the AI.
function guardSecrets(text: string) {
  if (/connection_secrets/i.test(text)) throw new ToolError("Bentley's connection tokens are off-limits.");
}

/* ---------- Reading ---------- */

const listProjects = defineTool({
  name: "supabase_list_projects",
  provider: "supabase",
  description: "List the person's Supabase projects (name, id, region and status).",
  parameters: { type: "object", properties: {} },
  risky: false,
  parse: () => ({}),
  async run(_args, ctx) {
    const projects = (await supabaseApi(ctx, "/projects")) as Record<string, unknown>[];
    return projects.map((project) => ({ name: project.name, id: project.id, region: project.region, status: project.status }));
  },
});

const listTables = defineTool({
  name: "supabase_list_tables",
  provider: "supabase",
  description: "List the tables in one schema of a Supabase project's database (default schema: public).",
  parameters: {
    type: "object",
    properties: {
      project: { type: "string", description: "The project id from supabase_list_projects." },
      schema: { type: "string", description: "Schema name. Default public." },
    },
    required: ["project"],
  },
  risky: false,
  parse: (raw) => ({ project: requiredProject(raw), schema: identifier(raw, "schema", "public") }),
  async run({ project, schema }, ctx) {
    const sql =
      "select table_name, table_type from information_schema.tables " +
      `where table_schema = '${schema}' and table_name <> 'connection_secrets' order by table_name limit 200`;
    return await runSql(ctx, project, sql);
  },
});

const readRows = defineTool({
  name: "supabase_read_rows",
  provider: "supabase",
  description: "Read the first rows of one table in the public schema of a Supabase project.",
  parameters: {
    type: "object",
    properties: {
      project: { type: "string", description: "The project id from supabase_list_projects." },
      table: { type: "string", description: "The table name." },
      max_rows: { type: "number", description: `1 to ${MAX_ROWS}. Default 10.` },
    },
    required: ["project", "table"],
  },
  risky: false,
  parse: (raw) => {
    const table = identifier(raw, "table");
    guardSecrets(table);
    return { project: requiredProject(raw), table, count: limit(raw, "max_rows", 10, MAX_ROWS) };
  },
  async run({ project, table, count }, ctx) {
    return await runSql(ctx, project, `select * from public."${table}" limit ${count}`);
  },
});

const listFunctions = defineTool({
  name: "supabase_list_functions",
  provider: "supabase",
  description: "List the Edge Functions deployed in a Supabase project.",
  parameters: {
    type: "object",
    properties: { project: { type: "string", description: "The project id from supabase_list_projects." } },
    required: ["project"],
  },
  risky: false,
  parse: (raw) => ({ project: requiredProject(raw) }),
  async run({ project }, ctx) {
    const functions = (await supabaseApi(ctx, `/projects/${project}/functions`)) as Record<string, unknown>[];
    return functions.map((item) => ({ slug: item.slug, status: item.status, version: item.version }));
  },
});

/* ---------- Running SQL (always asks first) ---------- */

const MAX_SQL_CHARS = 3000;

const sql = defineTool({
  name: "supabase_run_sql",
  provider: "supabase",
  description:
    "Run SQL on a Supabase project's database. It runs with full access, so the person always sees the exact SQL and must approve it first. Use it for changes, or for questions the other tools cannot answer.",
  parameters: {
    type: "object",
    properties: {
      project: { type: "string", description: "The project id from supabase_list_projects." },
      sql: { type: "string", description: "The SQL to run." },
    },
    required: ["project", "sql"],
  },
  risky: true,
  parse: (raw) => {
    const text = requiredText(raw, "sql", MAX_SQL_CHARS);
    guardSecrets(text);
    return { project: requiredProject(raw), sql: text };
  },
  async describe({ project, sql }, ctx) {
    const projects = (await supabaseApi(ctx, "/projects")) as { id: string; name: string }[];
    const name = projects.find((item) => item.id === project)?.name;
    if (!name) throw new ToolError("That project was not found in the person's Supabase account.");
    return `Run this SQL on "${name}":\n${sql}`;
  },
  async run({ project, sql }, ctx) {
    const rows = await runSql(ctx, project, sql);
    return Array.isArray(rows) ? { rows: rows.slice(0, MAX_ROWS), total_rows: rows.length } : { result: shorten(JSON.stringify(rows), 1000) };
  },
});

export const SUPABASE_TOOLS: Tool[] = [listProjects, listTables, readRows, listFunctions, sql];
