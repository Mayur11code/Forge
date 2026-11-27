"use client";

import { useMemo } from "react";
import { Plus, Trash2, Filter } from "lucide-react";
import {
  TriggerFilterOperatorSchema,
  type TriggerFilterConfig,
  type TriggerFilterRule,
  type TriggerFilterOperator,
} from "@/lib/workflow-types/trigger-filter";
import { AVAILABLE_TRIGGERS } from "@/lib/workflow-types/registry";

export interface TriggerFilterEditorProps {
  eventId?: string | null;
  filter?: TriggerFilterConfig | null;
  onChange: (filter: TriggerFilterConfig) => void;
}

const OPERATOR_LABELS: Record<TriggerFilterOperator, string> = {
  equals: "equals (=)",
  not_equals: "not equals (≠)",
  in: "is one of (in)",
  contains: "contains text",
};

export default function TriggerFilterEditor({
  eventId,
  filter,
  onChange,
}: TriggerFilterEditorProps) {
  const currentFilter: TriggerFilterConfig = useMemo(() => {
    return filter || { logic: "AND", rules: [] };
  }, [filter]);

  const availableFields = useMemo(() => {
    if (!eventId) return [];
    const triggerDef = AVAILABLE_TRIGGERS.find((t) => t.id === eventId);
    return triggerDef?.outputs || [];
  }, [eventId]);

  const handleAddRule = () => {
    const defaultField = availableFields[0] || "priority";
    const nextRules: TriggerFilterRule[] = [
      ...currentFilter.rules,
      {
        field: defaultField,
        operator: "equals",
        value: "",
      },
    ];

    onChange({
      ...currentFilter,
      rules: nextRules,
    });
  };

  const handleUpdateRule = (index: number, patch: Partial<TriggerFilterRule>) => {
    const nextRules = currentFilter.rules.map((rule, idx) => {
      if (idx !== index) return rule;
      return { ...rule, ...patch };
    });

    onChange({
      ...currentFilter,
      rules: nextRules,
    });
  };

  const handleRemoveRule = (index: number) => {
    const nextRules = currentFilter.rules.filter((_, idx) => idx !== index);
    onChange({
      ...currentFilter,
      rules: nextRules,
    });
  };

  const handleToggleLogic = (logic: "AND" | "OR") => {
    onChange({
      ...currentFilter,
      logic,
    });
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-white/[0.08] bg-black/40 p-3.5 shadow-inner">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-mono font-semibold tracking-wide text-zinc-300">
          <Filter size={13} className="text-amber-400" />
          <span>Execution Filters</span>
        </div>

        {currentFilter.rules.length > 1 && (
          <div className="flex items-center rounded-lg border border-white/[0.1] bg-black/60 p-0.5 text-[10px] font-mono">
            <button
              type="button"
              onClick={() => handleToggleLogic("AND")}
              className={`rounded px-1.5 py-0.5 transition-colors ${
                currentFilter.logic === "AND"
                  ? "bg-amber-500/20 text-amber-300 font-bold"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              AND
            </button>
            <button
              type="button"
              onClick={() => handleToggleLogic("OR")}
              className={`rounded px-1.5 py-0.5 transition-colors ${
                currentFilter.logic === "OR"
                  ? "bg-amber-500/20 text-amber-300 font-bold"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              OR
            </button>
          </div>
        )}
      </div>

      <p className="text-[11px] font-mono text-zinc-400 leading-relaxed">
        Only execute this workflow when the event payload satisfies these conditions.
      </p>

      {/* RULES LIST */}
      <div className="flex flex-col gap-2.5">
        {currentFilter.rules.map((rule, idx) => (
          <div
            key={idx}
            className="flex flex-col gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2"
          >
            <div className="flex items-center gap-2">
              {/* FIELD SELECTION */}
              {availableFields.length > 0 ? (
                <select
                  aria-label={`Filter field ${idx + 1}`}
                  className="flex-1 rounded-lg border border-white/[0.1] bg-black/80 px-2 py-1.5 text-[11px] font-mono text-zinc-200 outline-none focus:border-amber-500/50"
                  value={rule.field}
                  onChange={(e) => handleUpdateRule(idx, { field: e.target.value })}
                >
                  {availableFields.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  aria-label={`Filter field ${idx + 1}`}
                  placeholder="field"
                  className="flex-1 rounded-lg border border-white/[0.1] bg-black/80 px-2 py-1.5 text-[11px] font-mono text-zinc-200 outline-none focus:border-amber-500/50"
                  value={rule.field}
                  onChange={(e) => handleUpdateRule(idx, { field: e.target.value })}
                />
              )}

              {/* OPERATOR */}
              <select
                aria-label={`Filter operator ${idx + 1}`}
                className="w-32 rounded-lg border border-white/[0.1] bg-black/80 px-2 py-1.5 text-[11px] font-mono text-zinc-200 outline-none focus:border-amber-500/50"
                value={rule.operator}
                onChange={(e) =>
                  handleUpdateRule(idx, {
                    operator: e.target.value as TriggerFilterOperator,
                  })
                }
              >
                {TriggerFilterOperatorSchema.options.map((op) => (
                  <option key={op} value={op}>
                    {OPERATOR_LABELS[op]}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => handleRemoveRule(idx)}
                aria-label={`Remove condition ${idx + 1}`}
                className="p-1 text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 rounded transition-all"
                title="Remove condition"
              >
                <Trash2 size={13} />
              </button>
            </div>

            {/* VALUE INPUT */}
            <input
              type="text"
              aria-label={`Filter value ${idx + 1}`}
              placeholder={rule.operator === "in" ? "value1, value2" : 'Expected value (e.g. "URGENT")'}
              className="w-full rounded-lg border border-white/[0.1] bg-black/80 px-2.5 py-1.5 text-[11px] font-mono text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-amber-500/50"
              value={Array.isArray(rule.value) ? rule.value.join(", ") : String(rule.value ?? "")}
              onChange={(e) => {
                const raw = e.target.value;
                if (rule.operator === "in") {
                  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
                  handleUpdateRule(idx, { value: parts });
                } else if (raw === "true" || raw === "false") {
                  handleUpdateRule(idx, { value: raw === "true" });
                } else if (!isNaN(Number(raw)) && raw.trim() !== "") {
                  handleUpdateRule(idx, { value: Number(raw) });
                } else {
                  handleUpdateRule(idx, { value: raw });
                }
              }}
            />
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={handleAddRule}
        className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-amber-500/30 bg-amber-500/5 py-1.5 text-[11px] font-mono font-medium text-amber-300 hover:bg-amber-500/10 hover:border-amber-500/50 transition-all"
      >
        <Plus size={12} />
        <span>Add Filter Condition</span>
      </button>
    </div>
  );
}
