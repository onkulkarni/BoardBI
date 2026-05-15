import { ChevronDown, ChevronRight } from "lucide-react";
import { fieldsForPicker, isDateField, type FieldDef, type JiraIssue } from "../../lib/jqlFields";
import { DateRangeSlicer } from "../slicers/DateRangeSlicer";
import { MultiSelectSlicer } from "../slicers/MultiSelectSlicer";
import { SingleSelectSlicer } from "../slicers/SingleSelectSlicer";
import { TextSearchSlicer } from "../slicers/TextSearchSlicer";
import type { Slicer } from "../../store/slicerStore";

type Props = {
  reportId: string;
  rows: JiraIssue[];
  fields: FieldDef[];
  slicers: Slicer[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onChange: (next: Slicer[]) => void;
};

export function SlicerBar({ rows, fields, slicers, collapsed, onToggleCollapsed, onChange }: Props) {
  if (slicers.length === 0) return null;

  const dateOptions = fieldsForPicker(fields)
    .filter(isDateField)
    .map((f) => ({ id: f.id, label: f.name }));
  const groupOptions = fieldsForPicker(fields).map((f) => ({ id: f.id, label: f.name }));

  const replace = (s: Slicer) => onChange(slicers.map((x) => (x.id === s.id ? s : x)));
  const remove = (id: string) => onChange(slicers.filter((x) => x.id !== id));

  const fallbackOpts = (current: string) => [{ id: current, label: current }];

  return (
    <div className="row" style={{ alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
      <button
        type="button"
        className="slicer-collapse-toggle"
        onClick={onToggleCollapsed}
        title={collapsed ? "Show slicers" : "Hide slicers"}
        aria-expanded={!collapsed}
        style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
      >
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        <span>{collapsed ? `Slicers (${slicers.length})` : "Slicers"}</span>
      </button>
      {!collapsed && slicers.map((s) => {
        if (s.type === "dateRange") {
          return (
            <DateRangeSlicer
              key={s.id}
              field={s.field}
              value={s.value}
              fieldOptions={dateOptions.length ? dateOptions : fallbackOpts(s.field)}
              onFieldChange={(field) => replace({ ...s, field })}
              onChange={(value) => replace({ ...s, value })}
              onRemove={() => remove(s.id)}
            />
          );
        }
        if (s.type === "multiSelect") {
          return (
            <MultiSelectSlicer
              key={s.id}
              field={s.field}
              value={s.value}
              rows={rows}
              fieldOptions={groupOptions.length ? groupOptions : fallbackOpts(s.field)}
              onFieldChange={(field) => replace({ ...s, field, value: [] })}
              onChange={(value) => replace({ ...s, value })}
              onRemove={() => remove(s.id)}
            />
          );
        }
        if (s.type === "singleSelect") {
          return (
            <SingleSelectSlicer
              key={s.id}
              field={s.field}
              value={s.value}
              rows={rows}
              fieldOptions={groupOptions.length ? groupOptions : fallbackOpts(s.field)}
              onFieldChange={(field) => replace({ ...s, field, value: null })}
              onChange={(value) => replace({ ...s, value })}
              onRemove={() => remove(s.id)}
            />
          );
        }
        return (
          <TextSearchSlicer
            key={s.id}
            field={s.field}
            value={s.value}
            fieldOptions={groupOptions.length ? groupOptions : fallbackOpts(s.field)}
            onFieldChange={(field) => replace({ ...s, field })}
            onChange={(value) => replace({ ...s, value })}
            onRemove={() => remove(s.id)}
          />
        );
      })}
    </div>
  );
}
