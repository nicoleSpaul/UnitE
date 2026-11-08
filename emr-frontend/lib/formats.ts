import type { Exporter, ImportResult } from "./types";
import { hl7v2ToFhir } from "./toFhirJson/v2JToFhirJ";
import { fhirJToFhirJ } from "./toFhirJson/fhirJToFhirJ";
import { cdaToFhir } from "./toFhirJson/cdaToFhirJ";
import { fhirToCsv } from "./fromFhirJson/fhirJToCsv";
import { fhirJToFhirX } from "./fromFhirJson/fhirJToFhirX";
import { fhirJToV2J } from "./fromFhirJson/fhirJToV2J";
import { fhirJToCda } from "./fromFhirJson/fhirJToCda";
import { v2XToFhir } from "./toFhirJson/v2XToFhirJ";
import { fhirXToFhirJ } from "./toFhirJson/fhirXToFhirJ";
import { fhirJToV2X } from "./fromFhirJson/fhirJToV2X";

export type FormatId = "csv" | "v2" | "v2-xml" | "fhir-xml" | "fhir-json" | "cda";
export type Importer = (text: string) => ImportResult;

export type Format = {
    id: FormatId;
    label: string;
    hint?: string;
    exts: string[];
    canImport: boolean;   // false = shown as "coming soon"
    importer?: Importer;  // CSV has none: it goes through the mapping screen instead
    exporter?: Exporter;  // undefined = can't export yet
};

const fhirToJson: Exporter = (bundle, baseName) => ({
    blob: new Blob([JSON.stringify(bundle, null, 2)], { type: "application/fhir+json" }),
    filename: `${baseName}.fhir.json`,
    notes: [],
});

// order follows the sketch
export const FORMATS: Format[] = [
    { id: "csv", label: "CSV", exts: ["csv", "tsv", "txt"], canImport: true, exporter: fhirToCsv },
    { id: "v2", label: "HL7 v2 (pipe-delimited)", exts: ["hl7", "txt"], canImport: true, importer: hl7v2ToFhir, exporter: fhirJToV2J },
    { id: "v2-xml", label: "HL7 v2 XML", exts: ["xml"], canImport: true, importer: v2XToFhir, exporter: fhirJToV2X },
    { id: "fhir-xml", label: "HL7 FHIR XML", exts: ["xml"], canImport: true, importer: fhirXToFhirJ, exporter: fhirJToFhirX }, { id: "fhir-json", label: "HL7 FHIR JSON", hint: "standard for interoperability", exts: ["json", "fhir"], canImport: true, importer: fhirJToFhirJ, exporter: fhirToJson },
    { id: "cda", label: "HL7 CDA", exts: ["xml"], canImport: true, importer: cdaToFhir, exporter: fhirJToCda },
];

export function acceptFor(id: FormatId | "auto"): string {
    const exts =
        id === "auto"
            ? FORMATS.filter((f) => f.canImport).flatMap((f) => f.exts)
            : FORMATS.find((f) => f.id === id)?.exts ?? [];
    return [...new Set(exts)].map((e) => "." + e).join(",");
}

function sniffXml(head: string): FormatId | null {
    const body = head.replace(/<\?xml[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
    const m = /<([\w:.-]+)([^>]*)>/.exec(body);
    if (!m) return null;
    const root = m[1].replace(/^.*:/, "");
    if (root === "ClinicalDocument") return "cda";
    if (m[2].includes("urn:hl7-org:v2xml")) return "v2-xml";
    if (m[2].includes("http://hl7.org/fhir")) return "fhir-xml";
    return null;
}

// "Auto-detect": look at the content first, then fall back to the extension
export function detectFormat(name: string, text: string): FormatId | null {
    const head = text.replace(/^[\uFEFF\x0b]+/, "").trimStart().slice(0, 2000);
    if (head.startsWith("MSH|")) return "v2";
    if (head.startsWith("<")) return sniffXml(head);
    if (head.startsWith("{")) return "fhir-json";
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "hl7") return "v2";
    if (ext === "json" || ext === "fhir") return "fhir-json";
    if (["csv", "tsv", "txt"].includes(ext)) return "csv";
    return null;
}