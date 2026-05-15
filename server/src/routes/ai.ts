import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "../env.js";
import { prisma } from "../db.js";
import { getCachedFields } from "./fields.js";
import { GadgetInput, LayoutItem, PageSlicer } from "./reports.js";
import type { JiraField } from "../jira/client.js";

const router = Router();

class AiProviderError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const GenerateRequest = z.object({
  connectionId: z.string().min(1),
  prompt: z.string().min(1).max(2000),
});

const AiGadget = z.object({
  type: z.enum(["table", "bar", "pie", "line", "kpi"]),
  config: z.record(z.unknown()).default({}),
  layout: z.object({
    x: z.number().int().min(0).max(11),
    y: z.number().int().min(0),
    w: z.number().int().min(1).max(12),
    h: z.number().int().min(1),
  }),
});

const AiSlicer = z.object({
  type: z.enum(["dateRange", "multiSelect", "singleSelect", "text"]),
  field: z.string(),
  label: z.string().optional(),
  value: z.unknown().optional(),
});

const AiOutput = z.object({
  name: z.string().max(160).optional(),
  description: z.string().max(2000).optional(),
  jql: z.string(),
  gadgets: z.array(AiGadget).default([]),
  pageSlicers: z.array(AiSlicer).default([]),
});

type GadgetType = "table" | "bar" | "pie" | "line" | "kpi";

const GADGET_DEFAULTS: Record<GadgetType, { minW: number; minH: number }> = {
  table: { minW: 4, minH: 4 },
  bar: { minW: 3, minH: 4 },
  pie: { minW: 3, minH: 4 },
  line: { minW: 3, minH: 4 },
  kpi: { minW: 2, minH: 2 },
};

type SlicerType = "dateRange" | "multiSelect" | "singleSelect" | "text";

const AGG_FNS = new Set(["count", "sum", "avg", "min", "max"]);

function gadgetCompleteness(
  type: GadgetType,
  config: Record<string, unknown>,
): string | null {
  if (type === "table") {
    if (!Array.isArray(config.columns) || config.columns.length === 0) {
      return "table is missing 'columns'";
    }
    return null;
  }
  const fn = typeof config.fn === "string" ? config.fn : undefined;
  if (!fn || !AGG_FNS.has(fn)) return `${type} is missing a valid 'fn'`;
  const needsField = fn !== "count";
  if (needsField && typeof config.field !== "string") {
    return `${type} with fn="${fn}" requires a 'field'`;
  }
  if (type === "bar" || type === "pie") {
    if (typeof config.groupBy !== "string") return `${type} is missing 'groupBy'`;
  }
  if (type === "line") {
    if (typeof config.dateField !== "string") return "line is missing 'dateField'";
    if (typeof config.bucket !== "string") return "line is missing 'bucket'";
  }
  return null;
}

function defaultSlicerValue(type: SlicerType, v: unknown): unknown {
  if (type === "multiSelect") return Array.isArray(v) ? v : [];
  if (type === "singleSelect") return typeof v === "string" ? v : null;
  if (type === "text") return typeof v === "string" ? v : "";
  if (type === "dateRange") {
    return v && typeof v === "object" ? v : { preset: "ytd" };
  }
  return v ?? null;
}

function extractFieldRefs(type: GadgetType, config: Record<string, unknown>): string[] {
  const refs: string[] = [];
  if (type === "table") {
    const cols = config.columns;
    if (Array.isArray(cols)) {
      for (const c of cols) if (typeof c === "string") refs.push(c);
    }
  } else if (type === "bar" || type === "pie") {
    if (typeof config.groupBy === "string") refs.push(config.groupBy);
    if (typeof config.field === "string") refs.push(config.field);
  } else if (type === "line") {
    if (typeof config.dateField === "string") refs.push(config.dateField);
    if (typeof config.field === "string") refs.push(config.field);
  } else if (type === "kpi") {
    if (typeof config.field === "string") refs.push(config.field);
  }
  return refs;
}

function buildSystemPrompt(fields: JiraField[]): string {
  const roster = fields
    .map((f) => `${f.id} | ${f.name} | ${f.schema?.type ?? ""}`)
    .join("\n");
  return `You are a dashboard designer for BoardBI, a Power-BI-style app for JIRA.
Given a user's natural-language request, produce ONE report spec by calling
the generate_dashboard tool. Never reply in plain text.

The report has a single JQL query that fetches issues; all gadgets operate
over that one dataset client-side.

==== GADGET TYPES ====

Every gadget MUST have all REQUIRED config fields below. If you can't fill
a REQUIRED field with a real field id from the roster at the bottom, DROP
the gadget — do not emit a partial gadget. Partial gadgets are rejected.

table
  REQUIRED config: { columns: string[] }   // non-empty array of field ids
  Optional:        { pageSize?: number=50 }
  Example:
    { "type":"table",
      "config":{"columns":["summary","status","assignee","priority","created"]},
      "layout":{"x":0,"y":6,"w":8,"h":8} }

bar
  REQUIRED config: { fn: "count"|"sum"|"avg"|"min"|"max";
                     groupBy: <field id> }
  REQUIRED if fn != "count": { field: <numeric field id> }
  Optional:        { groupByBucket?: "day"|"week"|"month"|"quarter"|"year";
                     topN?: number=10; title?: string }
  Example:
    { "type":"bar",
      "config":{"fn":"count","groupBy":"priority","title":"Issues by Priority"},
      "layout":{"x":0,"y":0,"w":6,"h":6} }

pie
  REQUIRED config: { fn; groupBy: <field id> }
  REQUIRED if fn != "count": { field: <numeric field id> }
  Optional:        { groupByBucket?; topN?: number=8; donut?: boolean=true; title? }
  Example:
    { "type":"pie",
      "config":{"fn":"count","groupBy":"status","donut":true,"title":"Status mix"},
      "layout":{"x":6,"y":0,"w":4,"h":6} }

line
  REQUIRED config: { fn;
                     dateField: <date or datetime field id>;
                     bucket: "day"|"week"|"month"|"quarter"|"year" }
  REQUIRED if fn != "count": { field: <numeric field id> }
  Optional:        { title? }
  Example:
    { "type":"line",
      "config":{"fn":"count","dateField":"created","bucket":"week","title":"Created per week"},
      "layout":{"x":0,"y":6,"w":6,"h":6} }

kpi
  REQUIRED config: { fn }
  REQUIRED if fn != "count": { field: <numeric field id> }
  Optional:        { title? }
  Example:
    { "type":"kpi",
      "config":{"fn":"count","title":"Total open"},
      "layout":{"x":9,"y":0,"w":3,"h":3} }

Field rules (apply to ALL gadgets):
- Use ONLY field ids from the roster below. Do not invent fields. Custom fields
  look like customfield_NNNNN.
- fn in sum|avg|min|max requires a numeric field (schema.type === "number").
- line.dateField and any groupByBucket usage require a date/datetime field
  (schema.type === "date" | "datetime").

==== SLICERS ====

CRITICAL: each slicer must reference a DISTINCT \`field\`. Never emit two
slicers for the same field. If you'd add a "project" slicer twice, just
emit one.

Slicer types and \`value\` shapes:
- dateRange:    { preset: "thisMonth"|"lastMonth"|"thisQuarter"|"lastQuarter"|"ytd"|"custom"; from?: ISO; to?: ISO }
- multiSelect:  string[]   (use [] for "no initial selection")
- singleSelect: string | null
- text:         string

==== LAYOUT ====

The grid is 12 columns wide. Default sizes — KPI 3x3, bar/line 6x6,
pie 4x6, table 8x8. Place gadgets without overlapping. Typical pattern:
KPIs across the top row (y=0), charts below (y=3 or y=6), table last.

==== JQL ====

Use real JIRA operators (=, !=, in, ~, was, changed, ORDER BY). Quote
multi-word values. Examples:
  project = APA AND statusCategory != Done
  assignee = currentUser() AND created >= -30d
  issuetype = Bug AND priority in (High, Highest) ORDER BY created DESC

==== METADATA ====

Propose a short, descriptive \`name\` (<=60 chars) and optional \`description\`.

==== AVAILABLE JIRA FIELDS (id | name | schema.type) ====
${roster}
`;
}

const TOOL_INPUT_SCHEMA = {
  type: "object",
  required: ["jql", "gadgets"],
  properties: {
    name: { type: "string", maxLength: 160, description: "Short descriptive report name (<=60 chars preferred)." },
    description: { type: "string", maxLength: 2000 },
    jql: { type: "string", description: "JQL query that fetches the issues this dashboard visualizes." },
    gadgets: {
      type: "array",
      description: "Dashboard widgets. Each must have its REQUIRED config fields filled in or it will be discarded.",
      items: {
        type: "object",
        required: ["type", "config", "layout"],
        properties: {
          type: { type: "string", enum: ["table", "bar", "pie", "line", "kpi"] },
          config: {
            type: "object",
            description:
              "Per-gadget config. REQUIRED fields by type — table: columns; bar/pie: fn+groupBy; line: fn+dateField+bucket; kpi: fn. If fn is sum/avg/min/max, also fill 'field' with a numeric field id.",
            properties: {
              fn: {
                type: "string",
                enum: ["count", "sum", "avg", "min", "max"],
                description: "Aggregation function. REQUIRED for bar, pie, line, kpi.",
              },
              groupBy: {
                type: "string",
                description:
                  "Field id to group rows by. REQUIRED for bar and pie. Must be a field id from the roster.",
              },
              groupByBucket: {
                type: "string",
                enum: ["day", "week", "month", "quarter", "year"],
                description: "Only valid when groupBy is a date/datetime field.",
              },
              dateField: {
                type: "string",
                description:
                  "Date/datetime field id. REQUIRED for line. Must be a field id from the roster with schema.type date or datetime.",
              },
              bucket: {
                type: "string",
                enum: ["day", "week", "month", "quarter", "year"],
                description: "Time bucket for line charts. REQUIRED for line.",
              },
              field: {
                type: "string",
                description:
                  "Numeric field id used for sum/avg/min/max. REQUIRED when fn != count. Must be a field id from the roster with schema.type number.",
              },
              columns: {
                type: "array",
                items: { type: "string" },
                description: "Field ids to display as columns. REQUIRED for table. Non-empty.",
              },
              topN: { type: "integer", description: "Top-N truncation for bar/pie." },
              donut: { type: "boolean", description: "Render pie as donut." },
              pageSize: { type: "integer", description: "Rows per table page." },
              title: { type: "string", description: "Display title for the gadget." },
            },
          },
          layout: {
            type: "object",
            required: ["x", "y", "w", "h"],
            properties: {
              x: { type: "integer", minimum: 0, maximum: 11 },
              y: { type: "integer", minimum: 0 },
              w: { type: "integer", minimum: 1, maximum: 12 },
              h: { type: "integer", minimum: 1 },
            },
          },
        },
      },
    },
    pageSlicers: {
      type: "array",
      description:
        "Page-level filters. Each must reference a DISTINCT field id — never emit two slicers for the same field.",
      items: {
        type: "object",
        required: ["type", "field"],
        properties: {
          type: { type: "string", enum: ["dateRange", "multiSelect", "singleSelect", "text"] },
          field: { type: "string", description: "Field id from the roster." },
          label: { type: "string" },
          value: { description: "Initial value matching the slicer's type." },
        },
      },
    },
  },
};

async function callAnthropic(
  systemPrompt: string,
  userPrompt: string,
): Promise<unknown | null> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.anthropicModel,
      max_tokens: 4096,
      system: [
        { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: userPrompt }],
      tools: [
        {
          name: "generate_dashboard",
          description: "Emit the dashboard spec for the requested report.",
          input_schema: TOOL_INPUT_SCHEMA,
        },
      ],
      tool_choice: { type: "tool", name: "generate_dashboard" },
    }),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new AiProviderError(response.status, body, `Anthropic ${response.status}`);
  }
  if (!body || typeof body !== "object") return null;
  if ((body as { stop_reason?: unknown }).stop_reason !== "tool_use") return null;
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "tool_use" &&
      (block as { name?: unknown }).name === "generate_dashboard"
    ) {
      return (block as { input?: unknown }).input ?? null;
    }
  }
  return null;
}

async function callGemini(
  systemPrompt: string,
  userPrompt: string,
): Promise<unknown | null> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    env.geminiModel,
  )}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": env.geminiApiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: "generate_dashboard",
              description: "Emit the dashboard spec for the requested report.",
              parameters: TOOL_INPUT_SCHEMA,
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: "ANY",
          allowedFunctionNames: ["generate_dashboard"],
        },
      },
      generationConfig: { maxOutputTokens: 4096, temperature: 0.4 },
    }),
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new AiProviderError(response.status, body, `Gemini ${response.status}`);
  }
  const candidates = (body as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const parts = (candidates[0] as { content?: { parts?: unknown } } | undefined)?.content
    ?.parts;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    const fc = (part as { functionCall?: { name?: string; args?: unknown } })?.functionCall;
    if (fc && fc.name === "generate_dashboard") return fc.args ?? null;
  }
  return null;
}

async function callAi(systemPrompt: string, userPrompt: string): Promise<unknown | null> {
  const provider = env.aiProvider;
  if (provider === "gemini") return callGemini(systemPrompt, userPrompt);
  if (provider === "anthropic") return callAnthropic(systemPrompt, userPrompt);
  throw new Error(`Unknown AI_PROVIDER: ${provider}`);
}

type NormalizedSpec = {
  name?: string;
  description?: string;
  jql: string;
  gadgets: z.infer<typeof GadgetInput>[];
  layout: z.infer<typeof LayoutItem>[];
  pageSlicers: z.infer<typeof PageSlicer>[];
  warnings?: string[];
};

function normalizeAiSpec(
  aiInput: unknown,
  fields: JiraField[],
): { ok: true; data: NormalizedSpec } | { ok: false; error: string } {
  const aiParsed = AiOutput.safeParse(aiInput);
  if (!aiParsed.success) {
    return { ok: false, error: "AI returned a spec with an unexpected shape" };
  }

  const knownIds = new Set(fields.map((f) => f.id));
  const warnings: string[] = [];
  const gadgets: z.infer<typeof GadgetInput>[] = [];
  const layout: z.infer<typeof LayoutItem>[] = [];
  for (const g of aiParsed.data.gadgets) {
    const title = typeof g.config.title === "string" ? g.config.title : g.type;
    const missing = gadgetCompleteness(g.type, g.config);
    if (missing) {
      warnings.push(`Gadget "${title}" dropped: ${missing}`);
      continue;
    }
    const id = randomUUID();
    const def = GADGET_DEFAULTS[g.type];
    gadgets.push({ id, type: g.type, config: g.config });
    layout.push({
      i: id,
      x: g.layout.x,
      y: g.layout.y,
      w: g.layout.w,
      h: g.layout.h,
      minW: def.minW,
      minH: def.minH,
    });
    for (const ref of extractFieldRefs(g.type, g.config)) {
      if (!knownIds.has(ref)) {
        warnings.push(`Gadget "${title}" references unknown field "${ref}"`);
      }
    }
  }

  const pageSlicers: z.infer<typeof PageSlicer>[] = [];
  const seenSlicerFields = new Set<string>();
  for (const s of aiParsed.data.pageSlicers) {
    if (seenSlicerFields.has(s.field)) {
      warnings.push(`Duplicate slicer for field "${s.field}" dropped`);
      continue;
    }
    seenSlicerFields.add(s.field);
    pageSlicers.push({
      id: randomUUID(),
      type: s.type,
      field: s.field,
      label: s.label,
      value: defaultSlicerValue(s.type, s.value),
    });
    if (!knownIds.has(s.field)) {
      warnings.push(`Slicer references unknown field "${s.field}"`);
    }
  }

  const sanityG = z.array(GadgetInput).safeParse(gadgets);
  const sanityL = z.array(LayoutItem).safeParse(layout);
  const sanityP = z.array(PageSlicer).safeParse(pageSlicers);
  if (!sanityG.success || !sanityL.success || !sanityP.success) {
    return { ok: false, error: "AI spec failed validation against persistence schema" };
  }

  return {
    ok: true,
    data: {
      name: aiParsed.data.name,
      description: aiParsed.data.description,
      jql: aiParsed.data.jql,
      gadgets,
      layout,
      pageSlicers,
      warnings: warnings.length > 0 ? warnings : undefined,
    },
  };
}

function extractJsonObject(raw: string): unknown | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const trimmed = candidate.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to balanced-brace extraction
  }
  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

router.post("/generate-report", async (req, res) => {
  const parsed = GenerateRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const provider = env.aiProvider;
  const key = provider === "gemini" ? env.geminiApiKey : env.anthropicApiKey;
  if (!key) {
    res.json({ ok: false, error: `AI feature not configured (${provider})` });
    return;
  }
  const conn = await prisma.jiraConnection.findUnique({
    where: { id: parsed.data.connectionId },
  });
  if (!conn) {
    res.status(404).json({ ok: false, error: "Connection not found" });
    return;
  }

  let fields: JiraField[];
  try {
    const cached = await getCachedFields(parsed.data.connectionId);
    fields = cached.fields;
  } catch (err) {
    res.json({
      ok: false,
      error: err instanceof Error ? err.message : "Failed to load fields",
    });
    return;
  }

  let aiInput: unknown;
  try {
    aiInput = await callAi(buildSystemPrompt(fields), parsed.data.prompt);
    if (aiInput === null) {
      res.json({ ok: false, error: "AI did not return a structured spec" });
      return;
    }
  } catch (err) {
    if (err instanceof AiProviderError) {
      const detail =
        typeof (err.body as { error?: { message?: string } } | null)?.error?.message === "string"
          ? (err.body as { error: { message: string } }).error.message
          : `AI request failed (${err.status})`;
      res.json({ ok: false, error: detail });
      return;
    }
    res.json({
      ok: false,
      error: err instanceof Error ? err.message : "AI request failed",
    });
    return;
  }

  res.json(normalizeAiSpec(aiInput, fields));
});

const BuildPromptRequest = z.object({
  connectionId: z.string().min(1),
  prompt: z.string().max(2000).optional(),
});

router.post("/build-prompt", async (req, res) => {
  const parsed = BuildPromptRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const conn = await prisma.jiraConnection.findUnique({
    where: { id: parsed.data.connectionId },
  });
  if (!conn) {
    res.status(404).json({ ok: false, error: "Connection not found" });
    return;
  }

  let fields: JiraField[];
  try {
    const cached = await getCachedFields(parsed.data.connectionId);
    fields = cached.fields;
  } catch (err) {
    res.json({
      ok: false,
      error: err instanceof Error ? err.message : "Failed to load fields",
    });
    return;
  }

  const systemPrompt = buildSystemPrompt(fields);
  const userPrompt = parsed.data.prompt?.trim() ?? "";
  const userBlock = userPrompt.length > 0 ? userPrompt : "(describe your dashboard here)";
  const combined = `${systemPrompt}
==== USER REQUEST ====
${userBlock}

==== OUTPUT INSTRUCTIONS ====
Respond with a single JSON object matching the tool schema described above
(top-level keys: name, description, jql, gadgets[], pageSlicers[]). Wrap the
JSON in a \`\`\`json fenced code block. Do not include any other text.
`;

  res.json({ ok: true, data: { systemPrompt, userPrompt, combined } });
});

const ParseSpecRequest = z.object({
  connectionId: z.string().min(1),
  response: z.string().min(1).max(200_000),
});

router.post("/parse-spec", async (req, res) => {
  const parsed = ParseSpecRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const conn = await prisma.jiraConnection.findUnique({
    where: { id: parsed.data.connectionId },
  });
  if (!conn) {
    res.status(404).json({ ok: false, error: "Connection not found" });
    return;
  }

  let fields: JiraField[];
  try {
    const cached = await getCachedFields(parsed.data.connectionId);
    fields = cached.fields;
  } catch (err) {
    res.json({
      ok: false,
      error: err instanceof Error ? err.message : "Failed to load fields",
    });
    return;
  }

  const aiInput = extractJsonObject(parsed.data.response);
  if (aiInput === null) {
    res.json({ ok: false, error: "Could not find JSON in the pasted response" });
    return;
  }

  res.json(normalizeAiSpec(aiInput, fields));
});

export default router;
