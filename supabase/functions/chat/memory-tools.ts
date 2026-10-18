// Memory: lets Bentley save short facts about the person (their name, likes, projects) so she can
// use them in later chats. Only offered when the person turned Memory on in Settings.
// Nothing is ever deleted here: "Clear memories" in Settings switches memories off one by one.
import { defineTool, requiredText, ToolError } from "./tool-kit.ts";
import type { Tool } from "./tool-kit.ts";

const MAX_MEMORIES = 100; // active memories kept per person

const remember = defineTool({
  name: "remember",
  provider: "memory",
  description:
    "Save one short, lasting fact about the person (for example their name, a hobby, a goal or a preference) so you can use it in later chats. Only save things they told you themselves. Never save passwords, card numbers, health details or anything secret.",
  parameters: {
    type: "object",
    properties: { fact: { type: "string", description: "One short sentence, for example: Likes phonk music." } },
    required: ["fact"],
  },
  risky: false,
  parse: (raw) => ({ fact: requiredText(raw, "fact", 200) }),
  async run({ fact }, ctx) {
    if (!ctx.memoryOn) throw new ToolError("Memory is turned off.");

    const { data, error } = await ctx.admin.from("memories").select("memory").eq("user_id", ctx.userId).eq("active", true);
    if (error) throw new ToolError("Memory could not be read right now.");
    const known = (data || []).map((row) => String(row.memory).trim().toLowerCase());
    if (known.includes(fact.toLowerCase())) return { saved: true, note: "Already remembered." };
    if (known.length >= MAX_MEMORIES) throw new ToolError("Memory is full. Tell the person they can clear memories in Settings.");

    const { error: saveError } = await ctx.admin.from("memories").insert({ user_id: ctx.userId, memory: fact });
    if (saveError) throw new ToolError("Memory could not be saved right now.");
    return { saved: true };
  },
});

export const MEMORY_TOOLS: Tool[] = [remember];
