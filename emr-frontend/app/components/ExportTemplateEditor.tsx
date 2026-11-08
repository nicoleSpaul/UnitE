"use client";

import {
    DELIMITERS, MAX_COLUMNS, type Delimiter, type ExportColumn, type ExportTemplate,
} from "@/lib/exportTemplates";

export type SourceGroup = { label: string; options: { id: string; label: string }[] };

type Props = {
    draft: ExportTemplate;
    groups: SourceGroup[];
    saved: boolean;
    onChange: (next: ExportTemplate) => void;
    onSave: () => void;
    onDelete: () => void;
};

export default function ExportTemplateEditor({ draft, groups, saved, onChange, onSave, onDelete }: Props) {
    const flat = groups.flatMap((g) => g.options);
    const known = new Set(flat.map((o) => o.id));

    const setCol = (i: number, patch: Partial<ExportColumn>) =>
        onChange({ ...draft, columns: draft.columns.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

    const move = (i: number, d: -1 | 1) => {
        const j = i + d;
        if (j < 0 || j >= draft.columns.length) return;
        const cols = [...draft.columns];
        [cols[i], cols[j]] = [cols[j], cols[i]];
        onChange({ ...draft, columns: cols });
    };

    const remove = (i: number) => onChange({ ...draft, columns: draft.columns.filter((_, j) => j !== i) });

    const add = () =>
        onChange({
            ...draft,
            columns: [...draft.columns, { header: flat[0]?.label ?? "Column", source: flat[0]?.id ?? "" }],
        });

    const useAll = () =>
        onChange({ ...draft, columns: flat.slice(0, MAX_COLUMNS).map((o) => ({ header: o.label, source: o.id })) });

    return (
        <div className="space-y-3 rounded border p-3">
            <h3 className="font-semibold">Custom export template</h3>
            <p className="text-sm text-gray-500">
                Choose which columns to export, what to call them, and in what order. Each row is one clinical item
                with the patient columns repeated, and rows that come out identical are merged.
            </p>

            <div className="flex flex-wrap items-center gap-2">
                <input
                    className="rounded border p-1"
                    placeholder="Template name"
                    value={draft.name}
                    maxLength={80}
                    onChange={(e) => onChange({ ...draft, name: e.target.value })}
                />
                <select
                    className="rounded border p-1"
                    value={draft.delimiter}
                    onChange={(e) => onChange({ ...draft, delimiter: e.target.value as Delimiter })}
                >
                    {DELIMITERS.map((d) => (
                        <option key={d.label} value={d.value}>{d.label}</option>
                    ))}
                </select>
            </div>

            {draft.columns.length === 0 && (
                <p className="text-sm">No columns yet. Add one, or start from all available columns.</p>
            )}

            {draft.columns.map((c, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2">
                    <input
                        className="w-48 rounded border p-1"
                        value={c.header}
                        maxLength={80}
                        placeholder="Column header"
                        aria-label={`Header for column ${i + 1}`}
                        onChange={(e) => setCol(i, { header: e.target.value })}
                    />
                    <select
                        className="rounded border p-1"
                        value={c.source}
                        aria-label={`Field for column ${i + 1}`}
                        onChange={(e) => setCol(i, { source: e.target.value })}
                    >
                        {!known.has(c.source) && (
                            <option value={c.source}>
                                {c.source ? `${c.source} (not in this file)` : "(choose a field)"}
                            </option>
                        )}
                        {groups.map((g) => (
                            <optgroup key={g.label} label={g.label}>
                                {g.options.map((o) => (
                                    <option key={o.id} value={o.id}>{o.label}</option>
                                ))}
                            </optgroup>
                        ))}
                    </select>
                    <button onClick={() => move(i, -1)} disabled={i === 0} className="rounded border px-2 py-1" aria-label="Move up">↑</button>
                    <button onClick={() => move(i, 1)} disabled={i === draft.columns.length - 1} className="rounded border px-2 py-1" aria-label="Move down">↓</button>
                    <button onClick={() => remove(i)} className="rounded border px-2 py-1 text-red-600" aria-label="Remove column">✕</button>
                </div>
            ))}

            <div className="flex flex-wrap items-center gap-2">
                <button onClick={add} disabled={draft.columns.length >= MAX_COLUMNS} className="rounded border px-3 py-1">
                    + Add column
                </button>
                <button onClick={useAll} className="rounded border px-3 py-1">Use all columns</button>
                <button onClick={onSave} className="rounded bg-black px-3 py-1 text-white">Save template</button>
                {saved && (
                    <button onClick={onDelete} className="rounded border px-3 py-1 text-red-600">Delete template</button>
                )}
            </div>
        </div>
    );
}