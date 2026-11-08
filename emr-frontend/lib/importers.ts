import type { ImportResult } from "./types";
import { toBundle } from "./types";
import { hl7v2ToFhir } from "./toFhirJson/v2JToFhirJ";
import { fhirJToFhirJ } from "./toFhirJson/fhirJToFhirJ";
import { cdaToFhir } from "./toFhirJson/cdaToFhirJ";
// import { fhirXToFhirJ } from "./toFhirJson/fhirXToFhirJ";
// import { v2XToFhir } from "./toFhirJson/v2XToFhirJ";

type Importer = (text: string) => ImportResult;

// fill these in as each XML parser gets written
const XML_IMPORTERS: Partial<Record<"cda" | "fhir" | "v2", Importer>> = {
    cda: cdaToFhir,
    // fhir: fhirXToFhirJ,
    // v2: v2XToFhir,
};

const sniffXml: Importer = (text) => {
    const body = text
        .replace(/^\uFEFF/, "")
        .replace(/<\?xml[\s\S]*?\?>/g, "")
        .replace(/<!--[\s\S]*?-->/g, "");
    const m = /<([\w:.-]+)([^>]*)>/.exec(body);
    const root = m?.[1]?.replace(/^.*:/, "") ?? "";
    const attrs = m?.[2] ?? "";

    const kind =
        root === "ClinicalDocument" ? "cda"
            : attrs.includes("http://hl7.org/fhir") ? "fhir"
                : attrs.includes("urn:hl7-org:v2xml") ? "v2"
                    : null;

    const parse = kind ? XML_IMPORTERS[kind] : undefined;
    if (parse) return parse(text);

    return {
        bundle: toBundle([]),
        notes: [kind ? `${kind.toUpperCase()} XML import isn't built yet` : `Unrecognized XML root <${root || "?"}>`],
        patients: 0,
    };
};

// file extension -> parser
export const IMPORTERS: Record<string, Importer> = {
    hl7: hl7v2ToFhir,
    fhir: fhirJToFhirJ,   // your testFHIR.fhir
    json: fhirJToFhirJ,   // real FHIR downloads are .json
    xml: sniffXml,
};

// builds the file picker's accept list, e.g. ".csv,.hl7,.fhir,.json,.xml"
export const ACCEPT = [".csv", ...Object.keys(IMPORTERS).map((e) => "." + e)].join(",");