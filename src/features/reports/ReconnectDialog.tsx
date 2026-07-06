import { useState } from "react";
import { useConnections } from "../connections/useConnections";
import { useUpdateReport } from "./useReports";

type Props = {
  reportId: string;
  onClose: () => void;
};

export function ReconnectDialog({ reportId, onClose }: Props) {
  const { data: connections } = useConnections();
  const update = useUpdateReport(reportId);
  const [connectionId, setConnectionId] = useState("");

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
      <form
        className="card stack"
        style={{ width: "min(420px, 94vw)" }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          await update.mutateAsync({ connectionId });
          onClose();
        }}
      >
        <div style={{ fontWeight: 600 }}>Reconnect report</div>
        <div className="field">
          <label>Connection</label>
          <select
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
            required
          >
            <option value="">Choose…</option>
            {connections?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.baseUrl})
              </option>
            ))}
          </select>
        </div>
        {update.error && <div style={{ color: "var(--danger)" }}>{String(update.error)}</div>}
        <div className="row">
          <button className="primary" type="submit" disabled={!connectionId || update.isPending}>
            {update.isPending ? "Reconnecting…" : "Reconnect"}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
