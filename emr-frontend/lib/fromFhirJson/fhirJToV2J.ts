import { toBundle, type FhirResource, type ImportResult } from "../types";

const SYSTEMS: Record<string, string> = {
    LN: "http://loinc.org",
    LOINC: "http://loinc.org",
    RXNORM: "http://www.nlm.nih.gov/research/umls/rxnorm",
    SCT: "http://snomed.info/sct",
    SNM: "http://snomed.info/sct",
    SNOMED: "http://snomed.info/sct",
    I10: "http://hl7.org/fhir/sid/icd-10-cm",
    ICD10: "http://hl7.org/fhir/sid/icd-10-cm",
    "ICD-10": "http://hl7.org/fhir/sid/icd-10-cm",
    I9: "http://hl7.org/fhir/sid/icd-9-cm",
    ICD9: "http://hl7.org/fhir/sid/icd-9-cm",
};

const SEX: Record<string, string> = { M: "male", F: "female", O: "other", A: "other", U: "unknown", N: "unknown" };

const OBS_STATUS: Record<string, string> = {
    F: "final", P: "preliminary", C: "corrected", X: "cancelled", D: "entered-in-error", W: "entered-in-error",
};

const TEXT_TYPES = ["ST", "TX", "FT", "DT", "TM", "TS", "DTM"];
const CODED_TYPES = ["CWE", "CE", "CNE", "CF"];

export function hl7v2ToFhir(input: string): ImportResult {
    // strip BOM and MLLP framing bytes some HL7 feeds include
    const text = input.replace(/^\uFEFF/, "").replace(/[\x0b\x1c]/g, "");
    const lines = text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);

    const notes: string[] = [];
    const out: FhirResource[] = [];
    const skipped: Record<string, number> = {};
    const byMrn = new Map<string, string>();
    let pid: string | null = null;
    let patients = 0;
    let obrDate: string | undefined;
    let sawTime = false;

    // separators default to the standard ones and are re-read from each MSH
    let fieldSep = "|", compSep = "^", repSep = "~", subSep = "&";

    const unesc = (v: string) =>
        v.replace(/\\([FSTRE])\\/g, (_, c: string) =>
            ({ F: fieldSep, S: compSep, T: subSep, R: repSep, E: "\\" })[c] ?? "");

    // component i of repetition rep of a field
    const part = (field: string | undefined, i = 0, rep = 0) =>
        unesc((field ?? "").split(repSep)[rep]?.split(compSep)[i]?.trim() ?? "");

    const hl7Date = (v?: string) => {
        const s = (v ?? "").trim();
        const m = /^(\d{4})(\d{2})?(\d{2})?(\d+)?/.exec(s);
        if (!m) return undefined;
        if (m[4]) sawTime = true;
        const [, y, mo, d] = m;
        return mo && d ? `${y}-${mo}-${d}` : mo ? `${y}-${mo}` : y;
    };

    const codeable = (field?: string) => {
        const code = part(field, 0);
        const display = part(field, 1);
        const system = SYSTEMS[part(field, 2).toUpperCase()];
        return {
            ...(code ? { coding: [{ code, ...(display ? { display } : {}), ...(system ? { system } : {}) }] } : {}),
            text: display || code,
        };
    };

    for (const line of lines) {
        if (line.startsWith("MSH")) {
            fieldSep = line[3] ?? "|";
            const enc = line.split(fieldSep)[1] ?? "^~\\&";
            compSep = enc[0] ?? "^";
            repSep = enc[1] ?? "~";
            subSep = enc[3] ?? "&";
            continue;
        }

        const f = line.split(fieldSep);
        const seg = f[0];

        if (seg === "PID") {
            const idReps = (f[3] ?? "").split(repSep).filter(Boolean);
            const chosen = idReps.find((r) => r.split(compSep)[4]?.trim() === "MR") ?? idReps[0] ?? "";
            const mrn = unesc(chosen.split(compSep)[0]?.trim() ?? "");
            const label = mrn || `#${patients + 1}`;
            if (idReps.length > 1) notes.push(`Patient ${label}: kept 1 of ${idReps.length} identifiers`);

            // same MRN in several messages -> same Patient
            if (mrn && byMrn.has(mrn)) { pid = byMrn.get(mrn)!; continue; }

            pid = crypto.randomUUID();
            if (mrn) byMrn.set(mrn, pid);
            patients++;

            const p: FhirResource = { resourceType: "Patient", id: pid };
            if (mrn) p.identifier = [{ value: mrn }];

            const family = part(f[5], 0), given = part(f[5], 1), middle = part(f[5], 2);
            const full = [given, middle, family].filter(Boolean).join(" ");
            if (full) p.name = [{ text: full, ...(family ? { family } : {}), given: [given, middle].filter(Boolean) }];

            const dob = hl7Date(f[7]);
            if (dob) p.birthDate = dob;
            else if (f[7]) notes.push(`Patient ${label}: unreadable birth date "${f[7]}"`);

            if (f[8]) p.gender = SEX[f[8].toUpperCase()] ?? "unknown";
            out.push(p);
            continue;
        }

        if (seg === "OBR") { obrDate = hl7Date(f[7] || f[6]); continue; }

        if (!pid) { skipped[seg] = (skipped[seg] ?? 0) + 1; continue; }
        const subject = { reference: `Patient/${pid}` };

        if (seg === "DG1") {
            const code = codeable(f[3]);
            if (!code.text) { notes.push("DG1 with no diagnosis code skipped"); continue; }
            out.push({ resourceType: "Condition", id: crypto.randomUUID(), subject, code });
        } else if (seg === "AL1") {
            const code = codeable(f[3]);
            if (!code.text) { notes.push("AL1 with no allergen skipped"); continue; }
            out.push({ resourceType: "AllergyIntolerance", id: crypto.randomUUID(), patient: subject, code });
        } else if (seg === "RXE" || seg === "RXO" || seg === "RXA") {
            const code = codeable(seg === "RXE" ? f[2] : seg === "RXO" ? f[1] : f[5]);
            if (!code.text) { notes.push(`${seg} with no medication code skipped`); continue; }
            out.push({
                resourceType: "MedicationStatement", id: crypto.randomUUID(), subject,
                status: seg === "RXA" ? "completed" : "unknown",
                medicationCodeableConcept: code,
            });
        } else if (seg === "OBX") {
            const code = codeable(f[3]);
            if (!code.text) { notes.push("OBX with no test code skipped"); continue; }

            const obs: FhirResource = {
                resourceType: "Observation", id: crypto.randomUUID(), subject, code,
                status: OBS_STATUS[(f[11] ?? "").toUpperCase()] ?? "unknown",
            };

            const type = (f[2] ?? "").toUpperCase();
            const raw = f[5] ?? "";
            const unit = part(f[6], 0);

            if (type === "NM" || type === "SN") {
                const numStr = type === "SN" ? part(f[5], 1) : unesc(raw.split(repSep)[0]?.trim() ?? "");
                const n = Number(numStr);
                if (numStr !== "" && Number.isFinite(n)) {
                    obs.valueQuantity = { value: n, ...(unit ? { unit } : {}) };
                } else if (raw) {
                    obs.valueString = unesc(raw);
                    notes.push(`${code.text}: non-numeric value kept as text`);
                }
            } else if (CODED_TYPES.includes(type)) {
                obs.valueCodeableConcept = codeable(f[5]);
            } else if (raw) {
                obs.valueString = unesc(raw);
                if (!TEXT_TYPES.includes(type)) notes.push(`${code.text}: value type "${type || "?"}" stored as text`);
            }

            if (f[7]) obs.referenceRange = [{ text: unesc(f[7]) }];
            const flag = part(f[8], 0);
            if (flag) {
                obs.interpretation = [{
                    coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", code: flag }],
                }];
            }
            const when = hl7Date(f[14]) ?? obrDate;
            if (when) obs.effectiveDateTime = when;

            out.push(obs);
        } else {
            skipped[seg] = (skipped[seg] ?? 0) + 1;
        }
    }

    for (const [s, n] of Object.entries(skipped)) notes.push(`Skipped ${n} ${s} segment(s): not mapped yet`);
    if (sawTime) notes.push("Time of day was dropped from dates (FHIR requires a time zone, which HL7 v2 times here don't have)");
    if (patients === 0) notes.push("No PID segment found. Is this an HL7 v2 message?");

    return { bundle: toBundle(out), notes, patients };
}