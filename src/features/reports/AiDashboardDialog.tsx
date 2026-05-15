import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { HTTPError } from "ky";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { useCreateReport } from "./useReports";
import type { GadgetDef, LayoutItem, Report } from "./types";
import type { JiraConnection } from "../connections/types";
import type { Slicer } from "../../store/slicerStore";

type AiResult = {
  name?: string;
  description?: string;
  jql: string;
  gadgets: GadgetDef[];
  layout: LayoutItem[];
  pageSlicers: Slicer[];
  warnings?: string[];
};

type GenerateResponse = { ok: true; data: AiResult } | { ok: false; error: string };
type BuildPromptResponse =
  | { ok: true; data: { systemPrompt: string; userPrompt: string; combined: string } }
  | { ok: false; error: string };

type Mode = "api" | "manual";

type Props = {
  connections: JiraConnection[];
  defaultConnectionId?: string;
  onClose: () => void;
};

export function AiDashboardDialog({ connections, defaultConnectionId, onClose }: Props) {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<"prompt" | "preview">("prompt");
  const [mode, setMode] = useState<Mode>("api");
  const [connectionId, setConnectionId] = useState(
    defaultConnectionId ?? connections[0]?.id ?? "",
  );
  const [prompt, setPrompt] = useState("");
  const [genError, setGenError] = useState<string | null>(null);

  const [builtPrompt, setBuiltPrompt] = useState<string | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [pastedResponse, setPastedResponse] = useState("");
  const [copyOk, setCopyOk] = useState(false);

  const [name, setName] = useState("");
  const [jql, setJql] = useState("");
  const [gadgets, setGadgets] = useState<GadgetDef[]>([]);
  const [layout, setLayout] = useState<LayoutItem[]>([]);
  const [pageSlicers, setPageSlicers] = useState<Slicer[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);

  const generate = useMutation({
    mutationFn: async (body: { connectionId: string; prompt: string }) =>
      api
        .post("ai/generate-report", { json: body, timeout: 120_000 })
        .json<GenerateResponse>(),
  });
  const parseSpec = useMutation({
    mutationFn: async (body: { connectionId: string; response: string }) =>
      api.post("ai/parse-spec", { json: body }).json<GenerateResponse>(),
  });
  const create = useCreateReport();

  useEffect(() => {
    if (mode !== "manual" || phase !== "prompt" || !connectionId) return;
    let cancelled = false;
    setBuildError(null);
    const handle = window.setTimeout(async () => {
      try {
        const r = await api
          .post("ai/build-prompt", { json: { connectionId, prompt: prompt.trim() } })
          .json<BuildPromptResponse>();
        if (cancelled) return;
        if (r.ok) {
          setBuiltPrompt(r.data.combined);
        } else {
          setBuildError(r.error);
          setBuiltPrompt(null);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof HTTPError) {
          const body = (await err.response.json().catch(() => null)) as
            | { error?: string }
            | null;
          setBuildError(body?.error ?? `Request failed (${err.response.status})`);
        } else {
          setBuildError(err instanceof Error ? err.message : "Request failed");
        }
        setBuiltPrompt(null);
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [mode, phase, connectionId, prompt]);

  function acceptAiResult(d: AiResult) {
    setName(d.name ?? "");
    setJql(d.jql);
    setGadgets(d.gadgets);
    setLayout(d.layout);
    setPageSlicers(d.pageSlicers);
    setWarnings(d.warnings ?? []);
    setPhase("preview");
  }

  async function onGenerate() {
    setGenError(null);
    if (!connectionId || !prompt.trim()) return;
    try {
      const r = await generate.mutateAsync({ connectionId, prompt: prompt.trim() });
      if (!r.ok) {
        setGenError(r.error);
        return;
      }
      acceptAiResult(r.data);
    } catch (err) {
      if (err instanceof HTTPError) {
        const body = (await err.response.json().catch(() => null)) as
          | { error?: string }
          | null;
        setGenError(body?.error ?? `Request failed (${err.response.status})`);
      } else {
        setGenError(err instanceof Error ? err.message : "Request failed");
      }
    }
  }

  async function onUseResponse() {
    setGenError(null);
    if (!connectionId || !pastedResponse.trim()) return;
    try {
      const r = await parseSpec.mutateAsync({
        connectionId,
        response: pastedResponse,
      });
      if (!r.ok) {
        setGenError(r.error);
        return;
      }
      acceptAiResult(r.data);
    } catch (err) {
      if (err instanceof HTTPError) {
        const body = (await err.response.json().catch(() => null)) as
          | { error?: string }
          | null;
        setGenError(body?.error ?? `Request failed (${err.response.status})`);
      } else {
        setGenError(err instanceof Error ? err.message : "Request failed");
      }
    }
  }

  async function onCopyPrompt() {
    if (!builtPrompt) return;
    try {
      await navigator.clipboard.writeText(builtPrompt);
      setCopyOk(true);
      window.setTimeout(() => setCopyOk(false), 1500);
    } catch {
      // clipboard API can fail in insecure contexts; user can still select+copy manually
    }
  }

  function removeGadget(id: string) {
    setGadgets((prev) => prev.filter((g) => g.id !== id));
    setLayout((prev) => prev.filter((l) => l.i !== id));
  }

  function removeSlicer(id: string) {
    setPageSlicers((prev) => prev.filter((s) => s.id !== id));
  }

  async function onCreate() {
    setCreateError(null);
    if (!name.trim() || !connectionId) return;
    try {
      const created = await create.mutateAsync({
        name: name.trim(),
        connectionId,
        jql,
        layout,
        pageSlicers,
        gadgets,
      });
      onClose();
      navigate(`/reports/${(created as Report).id}`);
    } catch (err) {
      if (err instanceof HTTPError) {
        const body = (await err.response.json().catch(() => null)) as
          | { error?: string }
          | null;
        setCreateError(body?.error ?? `Create failed (${err.response.status})`);
      } else {
        setCreateError(err instanceof Error ? err.message : "Create failed");
      }
    }
  }

  const subtitle =
    phase === "preview"
      ? "Review the proposal, tweak as needed, then create the report."
      : mode === "api"
        ? "Describe the dashboard you want; AI will draft a JQL query, gadgets, and slicers."
        : "Copy the prompt into your LLM chat, then paste the response back here.";

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "grid",
        placeItems: "center",
        zIndex: 200,
      }}
    >
      <div
        className="card stack"
        style={{
          width: "min(760px, 94vw)",
          maxHeight: "86vh",
          padding: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="row"
          style={{
            justifyContent: "space-between",
            padding: "10px 14px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div>
            <div style={{ fontWeight: 600 }}>Generate dashboard with AI</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {subtitle}
            </div>
          </div>
          <button onClick={onClose}>Close</button>
        </div>

        {phase === "prompt" && (
          <div
            className="row"
            style={{
              gap: 0,
              padding: "0 14px",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <TabButton active={mode === "api"} onClick={() => setMode("api")}>
              Use AI API
            </TabButton>
            <TabButton active={mode === "manual"} onClick={() => setMode("manual")}>
              Manual chat
            </TabButton>
          </div>
        )}

        <div className="stack" style={{ overflow: "auto", padding: 14, gap: 10 }}>
          {phase === "prompt" && mode === "api" && (
            <PromptPhase
              connections={connections}
              connectionId={connectionId}
              setConnectionId={setConnectionId}
              prompt={prompt}
              setPrompt={setPrompt}
              error={genError}
            />
          )}
          {phase === "prompt" && mode === "manual" && (
            <ManualPhase
              connections={connections}
              connectionId={connectionId}
              setConnectionId={setConnectionId}
              prompt={prompt}
              setPrompt={setPrompt}
              builtPrompt={builtPrompt}
              buildError={buildError}
              onCopyPrompt={onCopyPrompt}
              copyOk={copyOk}
              pastedResponse={pastedResponse}
              setPastedResponse={setPastedResponse}
              error={genError}
            />
          )}
          {phase === "preview" && (
            <PreviewPhase
              name={name}
              setName={setName}
              jql={jql}
              setJql={setJql}
              gadgets={gadgets}
              layout={layout}
              pageSlicers={pageSlicers}
              warnings={warnings}
              onRemoveGadget={removeGadget}
              onRemoveSlicer={removeSlicer}
              createError={createError}
            />
          )}
        </div>

        <div
          className="row"
          style={{
            justifyContent: "space-between",
            padding: "10px 14px",
            borderTop: "1px solid var(--border)",
          }}
        >
          {phase === "prompt" ? (
            <>
              <span />
              <div className="row" style={{ gap: 8 }}>
                <button type="button" onClick={onClose}>
                  Cancel
                </button>
                {mode === "api" ? (
                  <button
                    type="button"
                    className="primary"
                    disabled={!connectionId || !prompt.trim() || generate.isPending}
                    onClick={onGenerate}
                  >
                    {generate.isPending ? "Generating…" : "Generate"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary"
                    disabled={
                      !connectionId || !pastedResponse.trim() || parseSpec.isPending
                    }
                    onClick={onUseResponse}
                  >
                    {parseSpec.isPending ? "Parsing…" : "Use response"}
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setPhase("prompt");
                  setCreateError(null);
                }}
              >
                Back
              </button>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!name.trim() || create.isPending}
                  onClick={onCreate}
                >
                  {create.isPending ? "Creating…" : "Create report"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        padding: "10px 14px",
        cursor: "pointer",
        fontWeight: active ? 600 : 400,
        color: active ? "var(--fg)" : "var(--muted)",
        borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
        marginBottom: -1,
      }}
    >
      {children}
    </button>
  );
}

function ConnectionPicker({
  connections,
  connectionId,
  setConnectionId,
}: {
  connections: JiraConnection[];
  connectionId: string;
  setConnectionId: (v: string) => void;
}) {
  if (connections.length <= 1) return null;
  return (
    <div className="field">
      <label>Connection</label>
      <select
        className="no-drag"
        value={connectionId}
        onChange={(e) => setConnectionId(e.target.value)}
      >
        <option value="">Choose…</option>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.baseUrl})
          </option>
        ))}
      </select>
    </div>
  );
}

function PromptPhase({
  connections,
  connectionId,
  setConnectionId,
  prompt,
  setPrompt,
  error,
}: {
  connections: JiraConnection[];
  connectionId: string;
  setConnectionId: (v: string) => void;
  prompt: string;
  setPrompt: (v: string) => void;
  error: string | null;
}) {
  return (
    <>
      <ConnectionPicker
        connections={connections}
        connectionId={connectionId}
        setConnectionId={setConnectionId}
      />
      <div className="field">
        <label>Describe your dashboard</label>
        <textarea
          className="no-drag"
          rows={6}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. open bugs by assignee for project APA, last quarter, with a KPI for total count"
        />
      </div>
      {error && <div style={{ color: "var(--danger)" }}>{error}</div>}
    </>
  );
}

function ManualPhase({
  connections,
  connectionId,
  setConnectionId,
  prompt,
  setPrompt,
  builtPrompt,
  buildError,
  onCopyPrompt,
  copyOk,
  pastedResponse,
  setPastedResponse,
  error,
}: {
  connections: JiraConnection[];
  connectionId: string;
  setConnectionId: (v: string) => void;
  prompt: string;
  setPrompt: (v: string) => void;
  builtPrompt: string | null;
  buildError: string | null;
  onCopyPrompt: () => void;
  copyOk: boolean;
  pastedResponse: string;
  setPastedResponse: (v: string) => void;
  error: string | null;
}) {
  return (
    <>
      <ConnectionPicker
        connections={connections}
        connectionId={connectionId}
        setConnectionId={setConnectionId}
      />
      <div className="field">
        <label>Describe your dashboard</label>
        <textarea
          className="no-drag"
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. open bugs by assignee for project APA, last quarter, with a KPI for total count"
        />
      </div>

      <div className="field">
        <div
          className="row"
          style={{ justifyContent: "space-between", alignItems: "center" }}
        >
          <label style={{ margin: 0 }}>Prompt to copy</label>
          <button
            type="button"
            onClick={onCopyPrompt}
            disabled={!builtPrompt}
            title="Copy prompt to clipboard"
          >
            {copyOk ? "Copied" : "Copy"}
          </button>
        </div>
        <textarea
          className="no-drag"
          rows={6}
          readOnly
          value={
            builtPrompt ??
            (buildError
              ? ""
              : connectionId
                ? "Building prompt…"
                : "Pick a connection to build the prompt.")
          }
          style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}
        />
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          Paste this into your LLM chat (Claude, ChatGPT, Gemini, etc.). Then bring the
          response back below.
        </div>
        {buildError && (
          <div style={{ color: "var(--danger)", marginTop: 4 }}>{buildError}</div>
        )}
      </div>

      <div className="field">
        <label>Paste LLM response</label>
        <textarea
          className="no-drag"
          rows={6}
          value={pastedResponse}
          onChange={(e) => setPastedResponse(e.target.value)}
          placeholder='Paste the full reply from the chat. JSON inside a ```json block is fine.'
          style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}
        />
      </div>

      {error && <div style={{ color: "var(--danger)" }}>{error}</div>}
    </>
  );
}

function PreviewPhase({
  name,
  setName,
  jql,
  setJql,
  gadgets,
  layout,
  pageSlicers,
  warnings,
  onRemoveGadget,
  onRemoveSlicer,
  createError,
}: {
  name: string;
  setName: (v: string) => void;
  jql: string;
  setJql: (v: string) => void;
  gadgets: GadgetDef[];
  layout: LayoutItem[];
  pageSlicers: Slicer[];
  warnings: string[];
  onRemoveGadget: (id: string) => void;
  onRemoveSlicer: (id: string) => void;
  createError: string | null;
}) {
  return (
    <>
      <div className="field">
        <label>Name</label>
        <input
          className="no-drag"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>
      <div className="field">
        <label>JQL</label>
        <textarea
          className="no-drag"
          rows={3}
          value={jql}
          onChange={(e) => setJql(e.target.value)}
        />
      </div>

      <div className="stack" style={{ gap: 6 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          Gadgets ({gadgets.length})
        </div>
        {gadgets.length === 0 && (
          <div className="muted" style={{ fontSize: 13 }}>
            No gadgets in this proposal.
          </div>
        )}
        {gadgets.map((g) => {
          const l = layout.find((x) => x.i === g.id);
          return (
            <div
              key={g.id}
              className="row card"
              style={{ justifyContent: "space-between", padding: "6px 10px" }}
            >
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <span
                  style={{
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    padding: "1px 6px",
                    fontSize: 11,
                    textTransform: "uppercase",
                  }}
                >
                  {g.type}
                </span>
                <span>{summarizeGadget(g)}</span>
                {l && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    {l.w}×{l.h} @ ({l.x},{l.y})
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => onRemoveGadget(g.id)}
                title="Remove"
                aria-label="Remove gadget"
                style={{ display: "inline-flex", alignItems: "center", padding: "2px 6px" }}
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="stack" style={{ gap: 6 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          Page slicers ({pageSlicers.length})
        </div>
        {pageSlicers.length === 0 && (
          <div className="muted" style={{ fontSize: 13 }}>
            No page slicers.
          </div>
        )}
        {pageSlicers.map((s) => (
          <div
            key={s.id}
            className="row card"
            style={{ justifyContent: "space-between", padding: "6px 10px" }}
          >
            <div className="row" style={{ gap: 8, alignItems: "center" }}>
              <span
                style={{
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  padding: "1px 6px",
                  fontSize: 11,
                  textTransform: "uppercase",
                }}
              >
                {s.type}
              </span>
              <span>{s.label ?? s.field}</span>
              <span className="muted" style={{ fontSize: 12 }}>
                {s.field}
              </span>
            </div>
            <button
              type="button"
              onClick={() => onRemoveSlicer(s.id)}
              title="Remove"
              aria-label="Remove slicer"
              style={{ display: "inline-flex", alignItems: "center", padding: "2px 6px" }}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>

      {warnings.length > 0 && (
        <div
          className="stack"
          style={{
            gap: 4,
            padding: 10,
            border: "1px solid var(--border)",
            borderRadius: 4,
            background: "var(--bg)",
          }}
        >
          <div className="muted" style={{ fontSize: 12, fontWeight: 600 }}>
            Warnings
          </div>
          {warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 13 }}>
              {w}
            </div>
          ))}
        </div>
      )}

      {createError && <div style={{ color: "var(--danger)" }}>{createError}</div>}
    </>
  );
}

function summarizeGadget(g: GadgetDef): string {
  const c = g.config;
  const title = typeof c.title === "string" ? c.title : undefined;
  if (title) return title;
  const fn = typeof c.fn === "string" ? c.fn : undefined;
  const groupBy = typeof c.groupBy === "string" ? c.groupBy : undefined;
  const dateField = typeof c.dateField === "string" ? c.dateField : undefined;
  const field = typeof c.field === "string" ? c.field : undefined;
  if (g.type === "table") {
    const cols = Array.isArray(c.columns) ? c.columns.length : 0;
    return `${cols} column${cols === 1 ? "" : "s"}`;
  }
  if (g.type === "kpi") return `${fn ?? "count"}${field ? ` of ${field}` : ""}`;
  if (g.type === "line") return `${fn ?? "count"} over ${dateField ?? "?"}`;
  return `${fn ?? "count"}${field ? ` of ${field}` : ""}${groupBy ? ` by ${groupBy}` : ""}`;
}
