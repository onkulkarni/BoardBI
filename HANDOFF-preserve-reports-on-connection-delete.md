# Handoff: Preserve reports when their JIRA connection is deleted

Status: planned, not yet implemented. Written for the next session to pick up and build.

## Context

Today, `Report.connectionId` is a required field with `onDelete: Cascade` at the database level (`server/prisma/schema.prisma`, mirrored in the SQLite FK in `server/prisma/migrations/20260507233244_init/migration.sql`). `DELETE /api/connections/:id` (`server/src/routes/connections.ts:57-60`) is a bare `prisma.jiraConnection.delete()` with no guard — so deleting a connection silently cascades to delete every `Report` that used it, and each deleted report cascades further to its `Gadget` and `DatasetSnapshot` rows.

The user needs to delete connections periodically (e.g. an expired JIRA API token — there is no in-place "edit connection" endpoint today, only create/delete), and currently that destroys all reports built on that connection, including their layout, gadgets, slicers, and fetched data. That's the bug being fixed.

## Decision (already made with the user, do not revisit)

When a connection is deleted, its reports must be **preserved**, not cascade-deleted. A report becomes **disconnected** (its `connectionId` is set to `null`) but keeps everything else — gadgets, layout, page slicers, and its last `DatasetSnapshot` (so existing charts/tables keep showing their last-fetched data). The user can then **reconnect** a disconnected report to a different (e.g. newly re-added) connection from the UI to resume refreshing, without recreating the report from scratch. (Rejected alternatives: blocking deletion via `Restrict` — doesn't match the token-rotation use case; adding in-place connection/token editing instead — solves a narrower problem and leaves the cascade-delete bug for other deletion reasons.)

## Implementation plan

### 1. Schema + migration
`server/prisma/schema.prisma` — `Report` model:
- `connectionId String` → `connectionId String?`
- `connection JiraConnection @relation(fields: [connectionId], references: [id], onDelete: Cascade)` → `connection JiraConnection? @relation(fields: [connectionId], references: [id], onDelete: SetNull)`

No other model changes. `Gadget`/`DatasetSnapshot`'s `onDelete: Cascade` from `Report` stay as-is (deleting a report itself should still remove its gadgets/snapshots). `FieldCache`'s `onDelete: Cascade` from `JiraConnection` stays as-is (that cache is connection-scoped and should vanish with the connection).

Run `npx prisma migrate dev --name make_report_connection_optional` from `server/`. SQLite has no in-place `ALTER TABLE`/FK-redefinition, so Prisma will emit a table-rebuild migration for `Report` only (same pattern already seen in `20260514063420_add_slicer_bar_collapsed/migration.sql`). Verify the generated SQL: `connectionId` column has no `NOT NULL`, the FK reads `ON DELETE SET NULL`, and only `Report` is rebuilt (not `Gadget`, `DatasetSnapshot`, `JiraConnection`, or `FieldCache`).

### 2. `server/src/routes/reports.ts`
- `shapeReport` (currently lines 115-146): widen `connectionId` to `string | null`, accept an optional `connection?: { id: string; name: string } | null`, and add `connectionName: r.connection?.name ?? null` to the returned shape.
- `GET /` (148) and `GET /:id` (156): add `connection: { select: { id: true, name: true } }` to their `include` (alongside existing `gadgets: true`). Never selects `apiToken`/`baseUrl`/`email`, so no leak risk.
- `POST /:id/data` (251, refresh): after the existing `if (!report)` 404 check, add `if (!report.connection) { res.status(400).json({ error: "This report's connection was deleted. Reconnect it to a connection before refreshing." }); return; }`. This also satisfies TypeScript once `report.connection` becomes `JiraConnection | null`.
- `UpdateReport` zod schema (46-54): add `connectionId: z.string().min(1).optional()` (not nullable — reassignment always targets a real connection).
- `PATCH /:id` handler (210-244): when `parsed.data.connectionId !== undefined`, look up `prisma.jiraConnection.findUnique`; 400 with `"Unknown connectionId"` if missing, otherwise add it to the `data` object being written (same pattern as the other `if (parsed.data.X !== undefined)` lines). Also add `connection: { select: { id: true, name: true } }` to the final `tx.report.findUniqueOrThrow` include so the response reflects the reassigned connection.
- `POST /` (create, 168) and `POST /import` (329): no change — both still require and validate `connectionId` up front.
- `DELETE /:id`, `/export`, `/:id/data/latest`: no change needed.

### 3. `server/src/routes/connections.ts`
No code change. Once the FK action is `SetNull`, `prisma.jiraConnection.delete()` at line 57-60 will never fail due to dependent reports, and the existing `.catch(() => {})` keeps serving its idempotency purpose. No new "usage count" endpoint — the frontend reuses the existing `GET /reports` list (already cached via `useReports()`) to compute affected-report counts client-side.

### 4. Frontend types (`src/features/reports/types.ts`)
- `Report.connectionId: string` → `string | null`; add `connectionName: string | null`.
- `UpdateReportInput` (currently a `Partial<{...}>` wrapper): add `connectionId: string` to the inner object.
- `CreateReportInput.connectionId` stays required. `ReportExport`/`ExportFile` unchanged (export already excludes `connectionId`).

### 5. `src/features/reports/ReportsPage.tsx`
- Per report row (currently ~100-136): show `r.connectionName` when connected, or a "Disconnected" badge (e.g. `style={{ color: "var(--danger)" }}`) when `r.connectionId === null`.
- Add a **Reconnect** button, shown only when `r.connectionId === null`, that opens the shared reconnect dialog (see #9) scoped to that report's id. Track which row's dialog is open with local state (e.g. `reconnectingId: string | null`), same pattern already used for `importOpen`/`aiOpen`.

### 6. `src/features/report/ReportPage.tsx`
- Line 19: `useFields(report?.connectionId)` → `useFields(report?.connectionId ?? undefined)` (type coercion now that `connectionId` can be `null`).
- Add a banner shown when `report.connectionId === null` (place near the top, e.g. above/alongside `ReportToolbar`): warns the connection was deleted, references `latest?.fetchedAt` for "last refreshed" context, and includes a **Reconnect** button opening the same shared dialog as #5, scoped to this report.
- No manual refetch needed after reconnecting — `useUpdateReport`'s existing `onSuccess` already does `qc.setQueryData(reportKey(id), data)`, so the banner disappears and `useFields`/Refresh re-enable automatically once `connectionId` is non-null again.
- `ReportToolbar` (`src/features/report/ReportToolbar.tsx`): add a `disconnected: boolean` prop (passed as `report.connectionId === null`). Extend the Refresh button's `disabled` (line 88) to also be `true` when disconnected, and adjust its title/tooltip. Leave "Edit JQL" enabled (editing text has no dependency on a live connection).
- `EmptyState`'s Refresh button (line 167): extend its `disabled` condition with `|| report.connectionId === null`.

### 7. `src/features/connections/ConnectionsPage.tsx`
- Add `const { data: reports } = useReports();` (from `../reports/useReports`) at the top of `ConnectionsPage`, and pass a `reportCount` prop to each `ConnectionCard` (count of `reports` matching that connection's id).
- Update the delete confirm (line 129) to mention affected reports when `reportCount > 0`, e.g. `` `Delete connection "${name}"? ${reportCount} report(s) using it will be preserved but disconnected — you can reconnect them later.` ``, falling back to the current plain message when 0.

### 8. `src/features/connections/useConnections.ts`
- Export the reports list-key constant from `useReports.ts` (currently an unexported `const LIST_KEY = ["reports"] as const;`) so it can be reused here, or reference the literal `["reports"]` directly.
- `useDeleteConnection`'s `onSuccess` (27-33): also `qc.invalidateQueries({ queryKey: ["reports"] })` alongside the existing `["connections"]` invalidation, so the Reports page reflects newly-orphaned reports immediately.

### 9. Shared reconnect dialog
New file `src/features/reports/ReconnectDialog.tsx`, following the existing modal pattern from `JqlBuilderDialog.tsx`. Props: `{ reportId: string; onClose: () => void }`. Body: a connection `<select>` sourced from `useConnections()` (same pattern as `NewReportForm`'s picker in `ReportsPage.tsx`), local state for the chosen id, and a submit that calls `useUpdateReport(reportId).mutateAsync({ connectionId })`. Surface server errors (e.g. unexpected 400) the same way `NewReportForm` does. Used from both `ReportsPage.tsx` (row action) and `ReportPage.tsx` (orphaned banner).

## Verification

1. `npm run dev`; on Connections, add a connection; on Reports, create a report against it and Refresh — confirm rows load and a `DatasetSnapshot` is written.
2. Delete that connection from Connections — confirm the browser confirm dialog mentions the affected report count, and the delete succeeds.
3. On Reports, confirm the report row still exists, now shows "Disconnected" with a Reconnect action; open the report directly and confirm the orphaned banner shows, existing gadgets/layout still render using the last snapshot, and Refresh is disabled.
4. Confirm `POST /api/reports/:id/data` against the disconnected report returns a clean `400` (not a 500) — e.g. via the disabled-but-inspectable network call, or a direct curl.
5. Add a new connection, use Reconnect (from either the list row or the report page banner) to point the report at it, and confirm the banner disappears and Refresh works again end-to-end (new snapshot written).
6. Inspect the SQLite DB (`npm run db:studio`) to confirm `connectionId` is `NULL` on the disconnected report before reconnecting, and that its `Gadget`/`DatasetSnapshot` row counts are unchanged from before the connection was deleted.
7. Type-check both projects: `npx vite build` (root) and `npm --prefix server run build`.
