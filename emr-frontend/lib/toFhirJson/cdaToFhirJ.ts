import { toBundle, type FhirResource, type ImportResult } from "../types";

type Concept = {
    coding?: { system?: string; code: string; display?: string }[];
    text: string;
};

const XSI = "http://www.w3.org/2001/XMLSchema-instance";

const SYSTEMS: Record<string, string> = {
    "2.16.840.1.113883.6.1": "http://loinc.org",
    "2.16.840.1.113883.6.96": "http://snomed.info/sct",
    "2.16.840.1.113883.6.88": "http://www.nlm.nih.gov/research/umls/rxnorm",
    "2.16.840.1.113883.6.90": "http://hl7.org/fhir/sid/icd-10-cm",
    "2.16.840.1.113883.6.103": "http://hl7.org/fhir/sid/icd-9-cm",
    "2.16.840.1.113883.6.69": "http://hl7.org/fhir/sid/ndc",
    "2.16.840.1.113883.12.292": "http://hl7.org/fhir/sid/cvx",
};

// LOINC section codes -> what we do with them
const SECTION_KIND: Record<string, "problems" | "meds" | "allergies" | "results" | "vitals"> = {
    "11450-4": "problems",
    "10160-0": "meds",
    "48765-2": "allergies",
    "30954-2": "results",
    "8716-3": "vitals",
};

// direct-child helpers (CDA nests deeply and reuses element names, so we avoid descendant search)
const kids = (el: Element | null | undefined, name: string): Element[] =>
    el ? Array.from(el.children).filter((c) => c.localName === name) : [];
const kid = (el: Element | null | undefined, name: string): Element | undefined =>
    kids(el, name)[0];
const dig = (el: Element | null | undefined, ...names: string[]): Element | undefined =>
    names.reduce<Element | undefined>((cur, n) => kid(cur, n), el ?? undefined);
const attr = (el: Element | null | undefined, name: string): string | undefined =>
    el?.getAttribute(name)?.trim() || undefined;
const txt = (el: Element | null | undefined): string | undefined =>
    el?.textContent?.trim() || undefined;
const xsiType = (el: Element): string =>
    (el.getAttributeNS(XSI, "type") || el.getAttribute("xsi:type") || "")
        .replace(/^.*:/, "")
        .toUpperCase();

// the entry's own observations, skipping nested ones (e.g. a problem's "status" observation)
const firstLevelObservations = (entry: Element): Element[] => {
    const direct = kids(entry, "observation");
    if (direct.length) return direct;
    return kids(kid(entry, "act"), "entryRelationship")
        .map((r) => kid(r, "observation"))
        .filter((o): o is Element => !!o);
};

export function cdaToFhir(input: string): ImportResult {
    const empty = (msg: string): ImportResult => ({ bundle: toBundle([]), notes: [msg], patients: 0 });

    const doc = new DOMParser().parseFromString(input.replace(/^\uFEFF/, ""), "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return empty("Not valid XML");
    const docEl = doc.documentElement;
    if (docEl.localName !== "ClinicalDocument") {
        return empty(`Expected a CDA <ClinicalDocument>, found <${docEl.localName}>`);
    }

    const notes: string[] = [];
    const out: FhirResource[] = [];
    let sawTime = false;

    const cdaDate = (v?: string) => {
        const m = /^(\d{4})(\d{2})?(\d{2})?(\d+)?/.exec((v ?? "").trim());
        if (!m) return undefined;
        if (m[4]) sawTime = true;
        const [, y, mo, d] = m;
        return mo && d ? `${y}-${mo}-${d}` : mo ? `${y}-${mo}` : y;
    };

    const concept = (el?: Element): Concept | undefined => {
        if (!el) return undefined;
        const code = attr(el, "code");
        const display = attr(el, "displayName");
        const original = txt(kid(el, "originalText"));
        const oid = attr(el, "codeSystem");
        const system = oid ? SYSTEMS[oid] ?? `urn:oid:${oid}` : undefined;
        const text = display || original || code;
        if (!text) return undefined;
        return {
            ...(code ? { coding: [{ ...(system ? { system } : {}), code, ...(display ? { display } : {}) }] } : {}),
            text,
        };
    };

    // ---------- patient ----------
    const role = dig(docEl, "recordTarget", "patientRole");
    if (!role) return empty("No recordTarget/patientRole: can't find the patient");

    const pid = crypto.randomUUID();
    const patient: FhirResource = { resourceType: "Patient", id: pid };

    const idEl = kids(role, "id").find((i) => attr(i, "extension"));
    if (idEl) {
        const oid = attr(idEl, "root");
        patient.identifier = [{ ...(oid ? { system: `urn:oid:${oid}` } : {}), value: attr(idEl, "extension") }];
    }

    const nameEl = dig(role, "patient", "name");
    if (nameEl) {
        const given = kids(nameEl, "given").map((g) => txt(g) ?? "").filter(Boolean);
        const family = txt(kid(nameEl, "family")) ?? "";
        const full = [...given, family].filter(Boolean).join(" ") || txt(nameEl) || "";
        if (full) {
            patient.name = [{ text: full, ...(family ? { family } : {}), ...(given.length ? { given } : {}) }];
        }
    }

    const g = attr(dig(role, "patient", "administrativeGenderCode"), "code")?.toUpperCase();
    if (g) patient.gender = g === "M" ? "male" : g === "F" ? "female" : "unknown";

    const bt = attr(dig(role, "patient", "birthTime"), "value");
    const dob = cdaDate(bt);
    if (dob) patient.birthDate = dob;
    else if (bt) notes.push(`Unreadable birth date "${bt}"`);

    out.push(patient);
    const subject = { reference: `Patient/${pid}` };

    // ---------- sections ----------
    for (const sec of Array.from(doc.getElementsByTagNameNS("*", "section"))) {
        const secCode = attr(kid(sec, "code"), "code");
        const title = txt(kid(sec, "title")) ?? secCode ?? "Untitled";
        const entries = kids(sec, "entry");
        const kind = secCode ? SECTION_KIND[secCode] : undefined;

        if (!kind) {
            if (entries.length) {
                notes.push(`Skipped section "${title}" (${entries.length} entr${entries.length === 1 ? "y" : "ies"}): not mapped yet`);
            }
            continue;
        }
        if (entries.length === 0) {
            if (txt(kid(sec, "text"))) notes.push(`Section "${title}" has narrative text but no coded entries: nothing imported`);
            continue;
        }

        if (kind === "problems") {
            for (const entry of entries) {
                for (const obs of firstLevelObservations(entry)) {
                    if (obs.getAttribute("negationInd") === "true") continue; // e.g. "no known problems"
                    const code = concept(kid(obs, "value"));
                    if (!code) { notes.push(`"${title}": entry with no coded problem skipped`); continue; }
                    const onset = cdaDate(attr(dig(obs, "effectiveTime", "low"), "value"));
                    out.push({
                        resourceType: "Condition", id: crypto.randomUUID(), subject, code,
                        ...(onset ? { onsetDateTime: onset } : {}),
                    });
                }
            }
        }

        if (kind === "meds") {
            for (const entry of entries) {
                for (const sa of kids(entry, "substanceAdministration")) {
                    if (sa.getAttribute("negationInd") === "true") continue;
                    const mat = dig(sa, "consumable", "manufacturedProduct", "manufacturedMaterial");
                    const name = txt(kid(mat, "name"));
                    const code = concept(kid(mat, "code")) ?? (name ? { text: name } : undefined);
                    if (!code) { notes.push(`"${title}": medication with no code or name skipped`); continue; }

                    const st = attr(kid(sa, "statusCode"), "code");
                    const dq = kid(sa, "doseQuantity");
                    const dose = [attr(dq, "value"), attr(dq, "unit")].filter(Boolean).join(" ");
                    out.push({
                        resourceType: "MedicationStatement", id: crypto.randomUUID(), subject,
                        status: st === "completed" ? "completed" : st === "active" ? "active" : st === "aborted" ? "stopped" : "unknown",
                        medicationCodeableConcept: code,
                        ...(dose ? { dosage: [{ text: dose }] } : {}),
                    });
                }
            }
        }

        if (kind === "allergies") {
            for (const entry of entries) {
                for (const obs of firstLevelObservations(entry)) {
                    if (obs.getAttribute("negationInd") === "true") continue;
                    const ent = dig(obs, "participant", "participantRole", "playingEntity");
                    const name = txt(kid(ent, "name"));
                    const code = concept(kid(ent, "code")) ?? (name ? { text: name } : undefined);
                    if (!code) { notes.push(`"${title}": allergy with no allergen skipped`); continue; }
                    out.push({ resourceType: "AllergyIntolerance", id: crypto.randomUUID(), patient: subject, code });
                }
            }
        }

        if (kind === "results" || kind === "vitals") {
            const list: Element[] = [];
            for (const entry of entries) {
                list.push(...kids(entry, "observation"));
                for (const org of kids(entry, "organizer")) {
                    for (const comp of kids(org, "component")) {
                        const o = kid(comp, "observation");
                        if (o) list.push(o);
                    }
                }
            }

            for (const obs of list) {
                const code = concept(kid(obs, "code"));
                if (!code) { notes.push(`"${title}": observation with no code skipped`); continue; }

                const st = attr(kid(obs, "statusCode"), "code");
                const o: FhirResource = {
                    resourceType: "Observation", id: crypto.randomUUID(), subject, code,
                    status: st === "completed" ? "final" : st === "active" ? "preliminary" : st === "aborted" ? "cancelled" : "unknown",
                };
                if (kind === "vitals") {
                    o.category = [{
                        coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }],
                    }];
                }

                const val = kid(obs, "value");
                if (val) {
                    const t = xsiType(val);
                    const v = attr(val, "value");
                    const n = Number(v);
                    if (t === "PQ" || t === "INT" || t === "REAL") {
                        const unit = attr(val, "unit");
                        if (v && Number.isFinite(n)) {
                            o.valueQuantity = {
                                value: n,
                                ...(unit ? { unit, system: "http://unitsofmeasure.org", code: unit } : {}),
                            };
                        } else {
                            notes.push(`${code.text}: unreadable numeric value kept out`);
                        }
                    } else if (t === "CD" || t === "CE" || t === "CV") {
                        const c = concept(val);
                        if (c) o.valueCodeableConcept = c;
                    } else if (t === "BL") {
                        o.valueBoolean = v === "true";
                    } else {
                        const s = txt(val);
                        if (s) o.valueString = s;
                    }
                }

                const flag = attr(kid(obs, "interpretationCode"), "code");
                if (flag) {
                    o.interpretation = [{
                        coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", code: flag }],
                    }];
                }
                const range = txt(kid(dig(obs, "referenceRange", "observationRange"), "text"));
                if (range) o.referenceRange = [{ text: range }];

                const when = cdaDate(attr(kid(obs, "effectiveTime"), "value") ?? attr(dig(obs, "effectiveTime", "low"), "value"));
                if (when) o.effectiveDateTime = when;

                out.push(o);
            }
        }
    }

    if (sawTime) notes.push("Time of day was dropped from dates (CDA times carry time zones that need separate handling)");
    return { bundle: toBundle(out), notes, patients: 1 };
}