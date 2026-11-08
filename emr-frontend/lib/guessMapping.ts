import { EXTENSION, TARGET_LIST } from "./targets";
import type { Mapping } from "./toFhirJson/csvToFhirJ";

export function guessMapping(headers: string[]): Mapping {
    const out: Mapping = {};
    const taken = new Set<string>();
    for (const h of headers) {
        const hit =
            TARGET_LIST.find((t) => t.id === h && !taken.has(t.id)) ??
            TARGET_LIST.find((t) => t.guess?.test(h) && !taken.has(t.id));
        if (hit) {
            out[h] = hit.id;
            taken.add(hit.id);
        } else {
            out[h] = EXTENSION; // unrecognized column: keep it instead of losing it
        }
    }
    return out;
}