import type { ExportResult, FhirBundle, FhirResource } from "../types";
import { auditFields, first, groupByPatient, isObj, lossNotes, nameParts, pretty, str, xmlEsc, type Obj } from "./shared";

const COVERED: Record<string, string[]> = {
    Patient: ["identifier", "name", "birthDate", "gender"],
    Condition: ["code", "subject", "onsetDateTime"],
    AllergyIntolerance: ["code", "patient"],
    MedicationStatement: ["medicationCodeableConcept", "subject", "status", "dosage"],
    Observation: [
        "code", "subject", "status", "category", "valueQuantity", "valueString", "valueCodeableConcept",
        "valueBoolean", "valueInteger", "referenceRange", "interpretation", "effectiveDateTime",
    ],
};

type Ctx = {
    multiCoding: number;
    timeDropped: boolean;
    unknownSystems: number;
    placeholderRoot: boolean;
    genderOther: boolean;
};
type Built = { xml: string; text: string };

const OIDS: [string, string][] = [
    ["loinc.org", "2.16.840.1.113883.6.1"],
    ["snomed.info", "2.16.840.1.113883.6.96"],
    ["rxnorm", "2.16.840.1.113883.6.88"],
    ["icd-10", "2.16.840.1.113883.6.90"],
    ["icd-9", "2.16.840.1.113883.6.103"],
    ["/ndc", "2.16.840.1.113883.6.69"],
    ["/cvx", "2.16.840.1.113883.12.292"],
];
const OBS_STATUS: Record<string, string> = {
    final: "completed", amended: "completed", corrected: "completed",
    preliminary: "active", registered: "active", cancelled: "aborted",
};
const MED_STATUS: Record<string, string> = {
    active: "active", completed: "completed", stopped: "aborted", "on-hold": "suspended", intended: "new",
};

const esc = (s: string) => xmlEsc(s.replace(/[\r\n\t]+/g, " "));
const at = (o: Record<string, string | undefined>) =>
    Object.entries(o)
        .filter(([, v]) => v)
        .map(([k, v]) => ` ${k}="${esc(v as string)}"`)
        .join("");

function oidFor(system: string, ctx: Ctx): string {
    if (!system) return "";
    if (system.startsWith("urn:oid:")) return system.slice(8);
    const hit = OIDS.find(([k]) => system.includes(k));
    if (!hit) { ctx.unknownSystems++; return ""; }
    return hit[1];
}

// a concept's human-readable name
function label(cc: unknown): string {
    const o: Obj = isObj(cc) ? cc : {};
    const c0: Obj = first(o.coding) ?? {};
    return str(o.text) || str(c0.display) || str(c0.code);
}

// a coded element, e.g. <code code=".." codeSystem=".." displayName=".."/>
function cd(tag: string, cc: unknown, ctx: Ctx, extra: Record<string, string> = {}): string {
    const o: Obj = isObj(cc) ? cc : {};
    const codings = Array.isArray(o.coding) ? o.coding : [];
    if (codings.length > 1) ctx.multiCoding++;
    const c0: Obj = isObj(codings[0]) ? codings[0] : {};
    const code = str(c0.code);
    const display = str(c0.display) || str(o.text);
    if (!code && !display) return `<${tag}${at({ ...extra, nullFlavor: "UNK" })}/>`;
    if (!code) {
        return `<${tag}${at({ ...extra, nullFlavor: "OTH" })}><originalText>${esc(display)}</originalText></${tag}>`;
    }
    return `<${tag}${at({ ...extra, code, codeSystem: oidFor(str(c0.system), ctx), displayName: display })}/>`;
}

function cdaDate(v: unknown, ctx: Ctx): string {
    const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?(T.*)?$/.exec(str(v));
    if (!m) return "";
    if (m[4]) ctx.timeDropped = true;
    return `${m[1]}${m[2] ?? ""}${m[3] ?? ""}`;
}

// ---------- entries ----------
function problem(r: FhirResource, ctx: Ctx): Built | null {
    const name = label(r.code);
    if (!name) return null;
    const onset = cdaDate(r.onsetDateTime, ctx);
    return {
        text: onset ? `${name} (since ${onset})` : name,
        xml:
            `<entry><act classCode="ACT" moodCode="EVN"><code nullFlavor="NA"/><statusCode code="active"/>` +
            `<entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">` +
            `<code code="55607006" displayName="Problem" codeSystem="2.16.840.1.113883.6.96"/>` +
            `<statusCode code="completed"/>` +
            `<effectiveTime><low${onset ? at({ value: onset }) : ` nullFlavor="UNK"`}/></effectiveTime>` +
            cd("value", r.code, ctx, { "xsi:type": "CD" }) +
            `</observation></entryRelationship></act></entry>`,
    };
}

function medication(r: FhirResource, ctx: Ctx): Built | null {
    const name = label(r.medicationCodeableConcept);
    if (!name) return null;
    const dosage = first(r.dosage);
    const dose = str(dosage?.text);
    const dqRaw = first(dosage?.doseAndRate)?.doseQuantity;
    const dq: Obj | undefined = isObj(dqRaw) ? dqRaw : undefined;
    const dqValue = dq?.value;
    const doseQ =
        dq && typeof dqValue === "number"
            ? `<doseQuantity${at({ value: String(dqValue), unit: str(dq.unit) })}/>`
            : "";
    const status = MED_STATUS[str(r.status)];
    return {
        text: dose ? `${name}: ${dose}` : name,
        xml:
            `<entry><substanceAdministration classCode="SBADM" moodCode="EVN">` +
            (dose ? `<text>${esc(dose)}</text>` : "") +
            (status ? `<statusCode code="${status}"/>` : "") +
            doseQ +
            `<consumable><manufacturedProduct><manufacturedMaterial>` +
            cd("code", r.medicationCodeableConcept, ctx) +
            `</manufacturedMaterial></manufacturedProduct></consumable>` +
            `</substanceAdministration></entry>`,
    };
}

function allergy(r: FhirResource, ctx: Ctx): Built | null {
    const name = label(r.code);
    if (!name) return null;
    return {
        text: name,
        xml:
            `<entry><act classCode="ACT" moodCode="EVN"><code nullFlavor="NA"/><statusCode code="active"/>` +
            `<entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">` +
            `<code code="ASSERTION" codeSystem="2.16.840.1.113883.5.4"/><statusCode code="completed"/>` +
            `<value xsi:type="CD" code="419199007" displayName="Allergy to substance" codeSystem="2.16.840.1.113883.6.96"/>` +
            `<participant typeCode="CSM"><participantRole classCode="MANU"><playingEntity classCode="MMAT">` +
            cd("code", r.code, ctx) +
            `</playingEntity></participantRole></participant>` +
            `</observation></entryRelationship></act></entry>`,
    };
}

function obsValue(r: Obj, ctx: Ctx): { xml: string; text: string } {
    const q = r.valueQuantity;
    const n = isObj(q) ? q.value : undefined;
    if (isObj(q) && typeof n === "number") {
        const unit = str(q.unit) || str(q.code);
        return {
            xml: `<value${at({ "xsi:type": "PQ", value: String(n), unit })}/>`,
            text: `${n}${unit ? " " + unit : ""}`,
        };
    }
    if (typeof r.valueInteger === "number") {
        return { xml: `<value${at({ "xsi:type": "INT", value: String(r.valueInteger) })}/>`, text: String(r.valueInteger) };
    }
    if (typeof r.valueString === "string") {
        const s = str(r.valueString);
        return { xml: `<value xsi:type="ST">${esc(s)}</value>`, text: s };
    }
    if (isObj(r.valueCodeableConcept)) {
        return { xml: cd("value", r.valueCodeableConcept, ctx, { "xsi:type": "CD" }), text: label(r.valueCodeableConcept) };
    }
    if (typeof r.valueBoolean === "boolean") {
        return { xml: `<value${at({ "xsi:type": "BL", value: String(r.valueBoolean) })}/>`, text: String(r.valueBoolean) };
    }
    return { xml: `<value xsi:type="ST" nullFlavor="NI"/>`, text: "(no value)" };
}

function rangeText(r: Obj): string {
    const rr = first(r.referenceRange);
    if (!rr) return "";
    if (str(rr.text)) return str(rr.text);
    const num = (x: unknown) => {
        const v = isObj(x) ? x.value : undefined;
        return typeof v === "number" ? v : undefined;
    };
    const lo = num(rr.low);
    const hi = num(rr.high);
    if (lo !== undefined && hi !== undefined) return `${lo}-${hi}`;
    if (lo !== undefined) return `>${lo}`;
    if (hi !== undefined) return `<${hi}`;
    return "";
}

function observation(r: FhirResource, ctx: Ctx): Built | null {
    const name = label(r.code);
    if (!name) return null;
    const st = OBS_STATUS[str(r.status)];
    const when = cdaDate(r.effectiveDateTime, ctx);
    const v = obsValue(r, ctx);
    const flag = str(first(first(r.interpretation)?.coding)?.code);
    const range = rangeText(r);
    return {
        text: `${name}: ${v.text}`,
        xml:
            `<component><observation classCode="OBS" moodCode="EVN">` +
            cd("code", r.code, ctx) +
            (st ? `<statusCode code="${st}"/>` : "") +
            `<effectiveTime${when ? at({ value: when }) : ` nullFlavor="UNK"`}/>` +
            v.xml +
            (flag ? `<interpretationCode${at({ code: flag, codeSystem: "2.16.840.1.113883.5.83" })}/>` : "") +
            (range
                ? `<referenceRange typeCode="REFV"><observationRange><text>${esc(range)}</text></observationRange></referenceRange>`
                : "") +
            `</observation></component>`,
    };
}

const isVital = (r: Obj) =>
    Array.isArray(r.category) &&
    r.category.some(
        (c) => isObj(c) && Array.isArray(c.coding) && c.coding.some((k) => isObj(k) && str(k.code) === "vital-signs")
    );

const organizer = (inner: string) =>
    `<entry><organizer classCode="CLUSTER" moodCode="EVN"><code nullFlavor="UNK"/>` +
    `<statusCode code="completed"/>${inner}</organizer></entry>`;

function section(code: string, title: string, built: Built[], wrap?: (inner: string) => string): string {
    if (!built.length) return "";
    const inner = built.map((b) => b.xml).join("");
    return (
        `<component><section>` +
        `<code code="${code}" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="${esc(title)}"/>` +
        `<title>${esc(title)}</title>` +
        `<text><list>${built.map((b) => `<item>${esc(b.text)}</item>`).join("")}</list></text>` +
        (wrap ? wrap(inner) : inner) +
        `</section></component>`
    );
}

// ---------- document ----------
export function fhirJToCda(bundle: FhirBundle, baseName: string): ExportResult {
    const ctx: Ctx = { multiCoding: 0, timeDropped: false, unknownSystems: 0, placeholderRoot: false, genderOther: false };
    const g = groupByPatient(bundle, COVERED);
    const filename = `${baseName}.cda.xml`;

    const firstP = [...g.patients][0];
    if (!firstP) {
        return { blob: new Blob([""], { type: "application/xml" }), filename, notes: ["No Patient resources found: nothing to export"] };
    }
    const [pid, patient] = firstP;
    const items = g.items.get(pid) ?? [];
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

    // patient header
    const idRaw = first(patient.identifier);
    const idVal = str(idRaw?.value);
    const sys = str(idRaw?.system);
    if (idVal && !sys.startsWith("urn:oid:")) ctx.placeholderRoot = true;
    const idEl = idVal
        ? `<id${at({ root: sys.startsWith("urn:oid:") ? sys.slice(8) : "2.16.840.1.113883.19.5", extension: idVal })}/>`
        : `<id root="${crypto.randomUUID()}"/>`;

    const { family, given } = nameParts(patient);
    const nameEl =
        family || given.length
            ? `<name>${given.map((x) => `<given>${esc(x)}</given>`).join("")}${family ? `<family>${esc(family)}</family>` : ""}</name>`
            : "";

    const gender = str(patient.gender);
    if (gender === "other") ctx.genderOther = true;
    const genderCode = gender === "male" ? "M" : gender === "female" ? "F" : "UN";
    const birth = cdaDate(patient.birthDate, ctx);

    const recordTarget =
        `<recordTarget><patientRole>${idEl}<patient>${nameEl}` +
        `<administrativeGenderCode code="${genderCode}" codeSystem="2.16.840.1.113883.5.1"/>` +
        `<birthTime${birth ? at({ value: birth }) : ` nullFlavor="UNK"`}/>` +
        `</patient></patientRole></recordTarget>`;

    const author =
        `<author><time value="${stamp}+0000"/><assignedAuthor><id nullFlavor="NA"/>` +
        `<assignedAuthoringDevice><softwareName>EMR Unifier</softwareName></assignedAuthoringDevice>` +
        `</assignedAuthor></author>`;
    const custodian =
        `<custodian><assignedCustodian><representedCustodianOrganization><id nullFlavor="NA"/>` +
        `<name>EMR Unifier export</name></representedCustodianOrganization></assignedCustodian></custodian>`;

    // body
    let skipped = 0;
    const keep = (list: (Built | null)[]) =>
        list.filter((b): b is Built => {
            if (!b) skipped++;
            return !!b;
        });
    const of = (type: string) => items.filter((r) => r.resourceType === type);
    const obs = of("Observation");

    const sections =
        section("11450-4", "Problems", keep(of("Condition").map((r) => problem(r, ctx)))) +
        section("10160-0", "Medications", keep(of("MedicationStatement").map((r) => medication(r, ctx)))) +
        section("48765-2", "Allergies", keep(of("AllergyIntolerance").map((r) => allergy(r, ctx)))) +
        section("30954-2", "Results", keep(obs.filter((r) => !isVital(r)).map((r) => observation(r, ctx))), organizer) +
        section("8716-3", "Vital signs", keep(obs.filter((r) => isVital(r)).map((r) => observation(r, ctx))), organizer);

    const body =
        sections ||
        `<component><section><code nullFlavor="NA"/><title>Summary</title>` +
        `<text>No problems, medications, allergies or results were included.</text></section></component>`;

    const doc =
        `<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
        `<typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>` +
        `<id root="${crypto.randomUUID()}"/>` +
        `<code code="34133-9" codeSystem="2.16.840.1.113883.6.1" displayName="Summarization of episode note"/>` +
        `<title>Health record summary</title>` +
        `<effectiveTime value="${stamp}+0000"/>` +
        `<confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/>` +
        `<languageCode code="en-US"/>` +
        recordTarget + author + custodian +
        `<component><structuredBody>${body}</structuredBody></component>` +
        `</ClinicalDocument>`;

    // report
    const notes = lossNotes(
        auditFields([patient, ...items], COVERED, ["name", "referenceRange", "interpretation", "dosage"]),
        g,
        "CDA"
    );
    if (g.patients.size > 1) {
        notes.push(`CDA holds one patient per document: exported the first of ${g.patients.size} patients, the rest were not included`);
    }
    if (skipped) notes.push(`${skipped} item(s) had no code or name and were skipped`);
    if (ctx.multiCoding) notes.push("Only the first coding of each code was kept");
    if (ctx.unknownSystems) notes.push(`${ctx.unknownSystems} code(s) from unrecognized systems were exported without a code system`);
    if (ctx.timeDropped) notes.push("Time of day was dropped from dates");
    if (ctx.placeholderRoot) notes.push("Identifier systems were not carried over; a placeholder root OID was used for the patient ID");
    if (ctx.genderOther) notes.push("Gender 'other' was exported as UN (unknown), which CDA's gender code allows");
    notes.push("Not a validated C-CDA: no template IDs, so it will not pass conformance checks. It does re-import into this tool");

    return {
        blob: new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${pretty(doc)}\n`], { type: "application/xml" }),
        filename,
        notes,
    };
}