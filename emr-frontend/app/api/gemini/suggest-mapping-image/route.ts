
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

const MAX_BYTES = 5 * 1024 * 1024;

const Body = z.object({
        image: z
        .instanceof(File, { message: "No image was sent" })
        .refine((f) => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(f.type), {
            message: "Use a PNG, JPG, GIF or WebP image",
        })
        .refine((f) => f.size <= MAX_BYTES, { message: "The image is over 5 MB" }),
});

export async function POST(req: Request) {
    let form: FormData;
    try {
        form = await req.formData();
    } catch {
        return Response.json({ error: "Bad request" }, { status: 400 });
    }

    const parsed = Body.safeParse({
        image: form.get("image"),
    });
    if (!parsed.success) {
        return Response.json(
            { error: parsed.error.issues[0]?.message ?? "Bad request" },
            { status: 400 }
        );
    }

    const prompt = `You are a clinical data extraction engine specializing in HL7 FHIR R4 interoperability. 
        Analyze the attached medical document image and extract all clinical and administrative information into a single, valid HL7 FHIR R4 Bundle resource (type: "collection" or "transaction") in strict JSON format.
        Strict Extraction Rules:
        1. Output Format: Return ONLY raw, valid JSON (\`application/fhir+json\`). Do not include markdown code fences (\`\`\`json), explanations, or conversational text.
        2. Zero Hallucination: Extract ONLY information explicitly visible in the image. If a required or optional field is missing or illegible, omit the field entirely. Never guess or fabricate dates, IDs, or values.
        3. Standard & Profiles: Conform to HL7 FHIR R4 (v4.0.1) and the US Core Implementation Guide where applicable.
        4. Terminology & Coding: Map extracted concepts to standard FHIR value sets and code systems where clear. To give some examples:
        - Diagnoses/Conditions: ICD-10-CM or SNOMED CT
        - Lab Results/Vitals: LOINC (include UCUM units for quantities)
        - Medications: RxNorm
        - Administrative Gender: \`male\` | \`female\` | \`other\` | \`unknown\`
        5. Data Formatting: Here are some examples of data formating that you need to adhere to:
        - Dates: ISO 8601 (\`YYYY-MM-DD\` or \`YYYY-MM-DDThh:mm:ssZ\`)
        - Phone numbers/Addresses: Parse into structured FHIR components (\`line\`, \`city\`, \`state\`, \`postalCode\`).
        6. Narrative Text: Include a valid XHTML (for example: \`<div xmlns="http://w3.org">\`) summary in the \`text\` field of each resource.
        Extract the data from the provided image now.`

    const { image } = parsed.data;

    try {
        const data = Buffer.from(await image.arrayBuffer()).toString("base64");
 
        const result = await ai.models.generateContent({
            model: "gemini-3.5-flash-lite", //newest standard flash model
            contents: [
                { inlineData: { mimeType: image.type, data } },
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