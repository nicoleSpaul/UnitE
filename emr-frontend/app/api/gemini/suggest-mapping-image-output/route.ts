
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_FHIR_BYTES = 2 * 1024 * 1024;

const FHIR_MIME_TYPES = [
    "application/fhir+json",
    "application/json",
    "application/fhir+xml",
    "application/xml",
    "text/xml",
];

const isFhirJson = (f: File) =>
    f.name.toLowerCase().endsWith(".json") || f.type.includes("json");
 
const Body = z.object({
    pdf: z
        .instanceof(File, { message: "No PDF was sent" })
        .refine((f) => f.type === "application/pdf", {
            message: "The document must be a PDF",
        })
        .refine((f) => f.size <= MAX_PDF_BYTES, { message: "The PDF is over 10 MB" }),
    fhir: z
        .instanceof(File, { message: "No FHIR file was sent" })
        .refine(
            (f) =>
                FHIR_MIME_TYPES.includes(f.type) ||
                // browsers often send an empty type for .json / .xml files
                /\.(json|xml)$/i.test(f.name),
            { message: "The FHIR file must be JSON or XML" }
        )
        .refine((f) => f.size <= MAX_FHIR_BYTES, { message: "The FHIR file is over 2 MB" }),
});

function checkFhir(text: string, asJson: boolean): string | null {
    if (asJson) {
        try {
            const obj = JSON.parse(text);
            if (typeof obj?.resourceType !== "string") {
                return 'The FHIR JSON has no "resourceType"';
            }
        } catch {
            return "The FHIR file is not valid JSON";
        }
        return null;
    }
    // XML: root element must be in the FHIR namespace
    if (!/<[A-Za-z]+[^>]*xmlns="http:\/\/hl7\.org\/fhir"/.test(text)) {
        return "The FHIR XML is missing the http://hl7.org/fhir namespace";
    }
    return null;
}

export async function POST(req: Request) {
    let form: FormData;
    try {
        form = await req.formData();
    } catch {
        return Response.json({ error: "Bad request" }, { status: 400 });
    }
 
    const parsed = Body.safeParse({
        pdf: form.get("pdf"),
        fhir: form.get("fhir"),
    });
    if (!parsed.success) {
        return Response.json(
            { error: parsed.error.issues[0]?.message ?? "Bad request" },
            { status: 400 }
        );
    }
 
    const { pdf, fhir } = parsed.data;
 
    const fhirText = await fhir.text();
    const fhirIsJson = isFhirJson(fhir);
    const fhirError = checkFhir(fhirText, fhirIsJson);
    if (fhirError) {
        return Response.json({ error: fhirError }, { status: 400 });
    }

    const prompt = `ou are a medical-form completion system. You will receive:
    (1) a PDF form, and
    (2) an HL7 FHIR R4 file (JSON; a single resource or a Bundle).
    Your job: find every writable section on the PDF, match each one to the
    correct information in the FHIR data, and specify the exact printed text to
    place in each bounding box. Do not fabricate data.
    
    PART 1: DETECT WRITABLE SECTIONS
    A writable section is any place a person is expected to write, mark, sign, or
    select something: fill-in lines or underscores, empty boxes or table cells,
    checkboxes and radio buttons (the mark target only), signature and initial
    areas, date fields (including segmented __/__/____), character-comb fields
    (treat the whole row as one field), and free-text areas.
    Exclude static labels, headings, instructions, decorative lines, logos,
    headers, footers, and page numbers.

    Coordinates: process every page (numbered from 1). Use a 0-1000 normalized
    scale, origin TOP-LEFT: [x_min, y_min, x_max, y_max]. The box must tightly
    cover the writing area, not the label. For a blank line, include the line plus
    about one text height above it. For a checkbox, box the square only. Do not
    merge separate fields or split one field.

    PART 2: INDEX THE FHIR DATA
    Before matching, silently build an index of the FHIR data:
    - List every resource (Patient, Practitioner, Organization, Coverage,
    Condition, AllergyIntolerance, MedicationRequest, Observation, Encounter,
    Procedure, Immunization, etc.) with its id.
    - For each, note the usable elements with their FHIRPath
    (e.g., Patient.name[0].given, Patient.birthDate, Patient.telecom[system=phone]).
    - Resolve references (e.g., Coverage.payor -> Organization) using Bundle
    entries by fullUrl or resource id.

    PART 3: MATCH FIELDS TO FHIR ELEMENTS
    For each detected field:
    1. Read its label, section heading, and nearby text to determine what is being
    asked (e.g., "DOB", "Insurance ID", "Current medications", "Allergies").
    2. Select the FHIR element(s) that answer it. Record the FHIRPath(s) used in
    "source_paths".
    3. When several candidates exist, choose by these rules:
    - Names: prefer use="official", then "usual"; ignore expired periods.
    - Addresses/telecom: prefer use="home" unless the form says work/mailing;
        prefer entries with no period.end or the latest period.
    - Identifiers: choose by type/system matching the label (MRN, SSN,
        Member ID, NPI, etc.).
    - Observations/Conditions/Medications: use only status active/final/
        completed as appropriate; prefer the most recent by effective/onset/
        authoredOn date. Exclude entered-in-error and inactive items unless the
        form asks for history.
    - Multiple items for one free-text area (e.g., medication list): join with
        "; " or newlines, whichever fits the box, and say so in "notes" if
        truncated.
    4. If the form asks for something absent from the FHIR data, leave the field
    empty (fill = null) and set match_status = "no_data". Never guess, infer
    clinical facts, or reuse a value for an unrelated field.
    5. If the field is a signature, or asks for patient attestation/consent, leave
    it empty with match_status = "requires_human".
    6. If the match is plausible but uncertain, fill it only if confidence >= 0.6;
    otherwise leave it empty with match_status = "uncertain".

    PART 4: FORMAT THE PRINTED TEXT
    Convert FHIR datatypes to plain printed text, following the form's own
    conventions where visible:
    - HumanName: "Family, Given" or "Given Family", whichever the label implies.
    If separate First / Middle / Last boxes exist, split accordingly.
    - Address: split into street, city, state, postal code if the form has
    separate fields; otherwise one line: "line, city, state postalCode".
    - ContactPoint: phone formatted per form (e.g., (555) 123-4567); email as-is.
    - date / dateTime / instant: match the form's format (MM/DD/YYYY by default
    for US forms; follow any format hint such as DD/MM/YYYY). Never include
    time unless asked.
    - CodeableConcept / Coding: print Coding.display or CodeableConcept.text; if
    the form asks for a code (ICD-10, CPT, NDC, RxNorm, LOINC), print the code
    value.
    - Quantity: "value unit" (e.g., "72 bpm", "5.4 mmol/L").
    - Identifier: the value only.
    - boolean / gender / status fields mapped to checkboxes or radios: see below.
    - Reference: resolve and print the referenced resource's display name.
    - Dosage: "drug, dose, route, frequency" in compact form.
    Use UPPERCASE only if the form's label requests it. Do not add labels or
    units the form already prints next to the box.

    Special field types:
    - checkbox / radio: set fill = "X" for the option that matches the data and
    null for the others in the group. Only mark an option if the data clearly
    supports it (e.g., Patient.gender = "female" -> mark "Female").
    Yes/No questions: mark "Yes" or "No" only if the data explicitly supports
    it; absence of a record is NOT "No".
    - comb: provide the characters as an array, one per cell, left-aligned
    unless the form indicates otherwise; truncate to the number of cells and flag
    truncation in notes.
    - date with segmented boxes: provide parts separately in "segments".
    - text_area: wrap into lines that fit.

    Fit: estimate the font size so the text fits the box on one line (or the
    required number of lines) between 6 and 12 pt. If it cannot fit at 6 pt,
    abbreviate only where unambiguous, otherwise truncate and note it.

    PART 5: FINAL CHECKS
    - Every PDF page appears in the output, even with empty fields.
    - Every filled value traces to a specific FHIR path; nothing is invented.
    - No bbox covers its label; no field is duplicated.
    - Prefilled fields are left untouched (fill = null).
    - Radio groups have at most one option marked.
    - Dates and phone numbers use consistent formatting across the form.
    `;

    try {
        const pdfData = Buffer.from(await pdf.arrayBuffer()).toString("base64");
 
        const result = await ai.models.generateContent({
            model: "gemini-3.5-flash-lite", //newest standard flash model
            contents: [
                { inlineData: { mimeType: "application/pdf", data: pdfData } },
                { text: prompt },
            ],
        });
        return Response.json({ text: result.text ?? "" });
    } catch (e) {
        console.error("Gemini error:", e);
        return Response.json(
            { error: e instanceof Error ? e.message : "Gemini request failed" },
            { status: 502 }
        );
    }

}

