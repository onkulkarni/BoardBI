import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { decrypt } from "../jira/crypto.js";
import { JiraError, searchAll } from "../jira/client.js";

const router = Router();

export const LayoutItem = z.object({
  i: z.string(),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  minW: z.number().int().positive().optional(),
  minH: z.number().int().positive().optional(),
});

export const PageSlicer = z.object({
  id: z.string(),
  type: z.enum(["dateRange", "multiSelect", "singleSelect", "text"]),
  field: z.string(),
  label: z.string().optional(),
  value: z.unknown(),
});

export const GadgetInput = z.object({
  id: z.string(),
  type: z.enum(["table", "bar", "pie", "line", "kpi"]),
  config: z.record(z.unknown()).default({}),
});

const CreateReport = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
  connectionId: z.string().min(1),
  jql: z.string().default(""),
  layout: z.array(LayoutItem).optional(),
  pageSlicers: z.array(PageSlicer).optional(),
  slicerBarCollapsed: z.boolean().optional(),
  gadgets: z.array(GadgetInput).optional(),
});

const UpdateReport = z.object({
  name: z.string().min(1).max(160).optional(),
  description: z.string().max(2000).optional(),
  connectionId: z.string().min(1).optional(),
  jql: z.string().optional(),
  layout: z.array(LayoutItem).optional(),
  pageSlicers: z.array(PageSlicer).optional(),
  slicerBarCollapsed: z.boolean().optional(),
  gadgets: z.array(GadgetInput).optional(),
});

const ReportExport = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(2000).nullable().optional(),
  jql: z.string().default(""),
  layout: z.array(LayoutItem).default([]),
  pageSlicers: z.array(PageSlicer).default([]),
  slicerBarCollapsed: z.boolean().default(false),
  gadgets: z.array(GadgetInput).default([]),
});

const ExportFile = z.object({
  version: z.literal(1),
  exportedAt: z.string(),
  reports: z.array(ReportExport),
});

const ExportRequest = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

const ImportRequest = z.object({
  connectionId: z.string().min(1),
  file: ExportFile,
});

type CompositeWrite = {
  layout?: z.infer<typeof LayoutItem>[];
  pageSlicers?: z.infer<typeof PageSlicer>[];
  gadgets?: z.infer<typeof GadgetInput>[];
};

async function writeReportComposite(
  tx: Prisma.TransactionClient,
  reportId: string,
  composite: CompositeWrite,
): Promise<void> {
  const data: Record<string, string> = {};
  if (composite.layout !== undefined) data.layout = JSON.stringify(composite.layout);
  if (composite.pageSlicers !== undefined)
    data.pageSlicers = JSON.stringify(composite.pageSlicers);
  if (Object.keys(data).length > 0) {
    await tx.report.update({ where: { id: reportId }, data });
  }
  if (composite.gadgets) {
    await tx.gadget.deleteMany({ where: { reportId } });
    if (composite.gadgets.length > 0) {
      await tx.gadget.createMany({
        data: composite.gadgets.map((g) => ({
          id: g.id,
          i: g.id,
          reportId,
          type: g.type,
          config: JSON.stringify(g.config),
        })),
      });
    }
  }
}

function shapeReport(r: {
  id: string;
  name: string;
  description: string | null;
  connectionId: string | null;
  connection?: { id: string; name: string } | null;
  jql: string;
  layout: string;
  pageSlicers: string;
  slicerBarCollapsed: boolean;
  createdAt: Date;
  updatedAt: Date;
  gadgets?: Array<{ id: string; type: string; config: string; i: string }>;
}) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    connectionId: r.connectionId,
    connectionName: r.connection?.name ?? null,
    jql: r.jql,
    layout: JSON.parse(r.layout) as unknown,
    pageSlicers: JSON.parse(r.pageSlicers) as unknown,
    slicerBarCollapsed: r.slicerBarCollapsed,
    gadgets:
      r.gadgets?.map((g) => ({
        id: g.id,
        type: g.type,
        config: JSON.parse(g.config) as unknown,
      })) ?? [],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

router.get("/", async (_req, res) => {
  const items = await prisma.report.findMany({
    orderBy: { updatedAt: "desc" },
    include: { gadgets: true, connection: { select: { id: true, name: true } } },
  });
  res.json(items.map(shapeReport));
});

router.get("/:id", async (req, res) => {
  const r = await prisma.report.findUnique({
    where: { id: req.params.id },
    include: { gadgets: true, connection: { select: { id: true, name: true } } },
  });
  if (!r) {
    res.status(404).json({ error: "Report not found" });
    return;
  }
  res.json(shapeReport(r));
});

router.post("/", async (req, res) => {
  const parsed = CreateReport.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const conn = await prisma.jiraConnection.findUnique({
    where: { id: parsed.data.connectionId },
  });
  if (!conn) {
    res.status(400).json({ error: "Unknown connectionId" });
    return;
  }
  const hasComposite =
    parsed.data.layout !== undefined ||
    parsed.data.pageSlicers !== undefined ||
    parsed.data.gadgets !== undefined;
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.report.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        connectionId: parsed.data.connectionId,
        jql: parsed.data.jql,
        slicerBarCollapsed: parsed.data.slicerBarCollapsed ?? false,
      },
    });
    if (hasComposite) {
      await writeReportComposite(tx, row.id, {
        layout: parsed.data.layout,
        pageSlicers: parsed.data.pageSlicers,
        gadgets: parsed.data.gadgets,
      });
    }
    return tx.report.findUniqueOrThrow({
      where: { id: row.id },
      include: { gadgets: true },
    });
  });
  res.status(201).json(shapeReport(created));
});

router.patch("/:id", async (req, res) => {
  const parsed = UpdateReport.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const existing = await prisma.report.findUnique({ where: { id: req.params.id } });
  if (!existing) {
    res.status(404).json({ error: "Report not found" });
    return;
  }

  if (parsed.data.connectionId !== undefined) {
    const conn = await prisma.jiraConnection.findUnique({
      where: { id: parsed.data.connectionId },
    });
    if (!conn) {
      res.status(400).json({ error: "Unknown connectionId" });
      return;
    }
  }

  const data: Record<string, string | boolean | null> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.description !== undefined) data.description = parsed.data.description;
  if (parsed.data.connectionId !== undefined) data.connectionId = parsed.data.connectionId;
  if (parsed.data.jql !== undefined) data.jql = parsed.data.jql;
  if (parsed.data.slicerBarCollapsed !== undefined)
    data.slicerBarCollapsed = parsed.data.slicerBarCollapsed;

  const updated = await prisma.$transaction(async (tx) => {
    if (Object.keys(data).length > 0) {
      await tx.report.update({ where: { id: req.params.id }, data });
    }
    await writeReportComposite(tx, req.params.id, {
      layout: parsed.data.layout,
      pageSlicers: parsed.data.pageSlicers,
      gadgets: parsed.data.gadgets,
    });
    return tx.report.findUniqueOrThrow({
      where: { id: req.params.id },
      include: { gadgets: true, connection: { select: { id: true, name: true } } },
    });
  });
  res.json(shapeReport(updated));
});

router.delete("/:id", async (req, res) => {
  await prisma.report.delete({ where: { id: req.params.id } }).catch(() => {});
  res.json({ ok: true });
});

router.post("/:id/data", async (req, res) => {
  const report = await prisma.report.findUnique({
    where: { id: req.params.id },
    include: { connection: true },
  });
  if (!report) {
    res.status(404).json({ error: "Report not found" });
    return;
  }
  if (!report.connection) {
    res.status(400).json({
      error: "This report's connection was deleted. Reconnect it to a connection before refreshing.",
    });
    return;
  }
  if (!report.jql.trim()) {
    res.status(400).json({ error: "Report has no JQL configured" });
    return;
  }
  try {
    const result = await searchAll(
      {
        baseUrl: report.connection.baseUrl,
        email: report.connection.email,
        apiToken: decrypt(report.connection.apiToken),
      },
      report.jql,
    );
    const snapshot = await prisma.datasetSnapshot.create({
      data: {
        reportId: report.id,
        rowCount: result.rows.length,
        truncated: result.truncated,
        rows: JSON.stringify(result.rows),
      },
    });
    res.json({
      snapshotId: snapshot.id,
      fetchedAt: snapshot.fetchedAt.toISOString(),
      rowCount: snapshot.rowCount,
      truncated: snapshot.truncated,
      rows: result.rows,
    });
  } catch (err) {
    if (err instanceof JiraError) {
      res.status(502).json({
        error: `JIRA returned ${err.status}`,
        details: err.body,
      });
      return;
    }
    throw err;
  }
});

router.post("/export", async (req, res) => {
  const parsed = ExportRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const items = await prisma.report.findMany({
    where: { id: { in: parsed.data.ids } },
    include: { gadgets: true },
  });
  const reports = items.map((r) => {
    const shaped = shapeReport(r);
    return {
      name: shaped.name,
      description: shaped.description,
      jql: shaped.jql,
      layout: shaped.layout,
      pageSlicers: shaped.pageSlicers,
      slicerBarCollapsed: shaped.slicerBarCollapsed,
      gadgets: shaped.gadgets,
    };
  });
  res.json({
    version: 1,
    exportedAt: new Date().toISOString(),
    reports,
  });
});

router.post("/import", async (req, res) => {
  const parsed = ImportRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    return;
  }
  const conn = await prisma.jiraConnection.findUnique({
    where: { id: parsed.data.connectionId },
  });
  if (!conn) {
    res.status(400).json({ error: "Unknown connectionId" });
    return;
  }

  const existing = await prisma.report.findMany({ select: { name: true } });
  const usedNames = new Set(existing.map((r) => r.name));
  function uniqueName(base: string): string {
    if (!usedNames.has(base)) {
      usedNames.add(base);
      return base;
    }
    let n = 1;
    while (true) {
      const candidate = n === 1 ? `${base} (imported)` : `${base} (imported ${n})`;
      if (!usedNames.has(candidate)) {
        usedNames.add(candidate);
        return candidate;
      }
      n++;
    }
  }

  const created = [];
  for (const r of parsed.data.file.reports) {
    const idMap = new Map<string, string>();
    for (const g of r.gadgets) idMap.set(g.id, randomUUID());
    const remappedLayout = r.layout
      .filter((l) => idMap.has(l.i))
      .map((l) => ({ ...l, i: idMap.get(l.i)! }));

    const row = await prisma.report.create({
      data: {
        name: uniqueName(r.name),
        description: r.description ?? null,
        connectionId: parsed.data.connectionId,
        jql: r.jql,
        layout: JSON.stringify(remappedLayout),
        pageSlicers: JSON.stringify(r.pageSlicers),
        slicerBarCollapsed: r.slicerBarCollapsed,
        gadgets: {
          create: r.gadgets.map((g) => {
            const newId = idMap.get(g.id)!;
            return {
              id: newId,
              i: newId,
              type: g.type,
              config: JSON.stringify(g.config),
            };
          }),
        },
      },
      include: { gadgets: true },
    });
    created.push(shapeReport(row));
  }
  res.status(201).json(created);
});

router.get("/:id/data/latest", async (req, res) => {
  const snap = await prisma.datasetSnapshot.findFirst({
    where: { reportId: req.params.id },
    orderBy: { fetchedAt: "desc" },
  });
  if (!snap) {
    res.status(404).json({ error: "No snapshot yet" });
    return;
  }
  res.json({
    snapshotId: snap.id,
    fetchedAt: snap.fetchedAt.toISOString(),
    rowCount: snap.rowCount,
    truncated: snap.truncated,
    rows: JSON.parse(snap.rows) as unknown,
  });
});

export default router;
