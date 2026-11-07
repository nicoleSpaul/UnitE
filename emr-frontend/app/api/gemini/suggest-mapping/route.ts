import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

const Body = z.object({
    headers: z.array(z.string()).max(100),
    sampleRows: z.array(z.record(z.string(), z.string())).max(5),
});

export async function POST(req: Request) {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
        return Response.json({ error: "Bad request" }, { status: 400 });
    }

    const prompt = `Map these CSV columns to FHIR R4 fields (Patient, Condition,
MedicationStatement, Observation). Return ONLY JSON in the form
{"mappings":[{"column":string,"fhirPath":string,"confidence":number}]}.
Use null for fhirPath if a column has no good match.
Headers: ${JSON.stringify(parsed.data.headers)}
Sample rows: ${JSON.stringify(parsed.data.sampleRows)}`;

    try {
        const result = await ai.models.generateContent({
            model: "gemini-3.8-flash", //newest standard flash model
            contents: prompt,
            config: { responseMimeType: "application/json" },
        });
        return Response.json(JSON.parse(result.text ?? "{}"));
    } catch (e) {
        console.error("Gemini error:", e);
        return Response.json(
            { error: e instanceof Error ? e.message : "Gemini request failed" },
            { status: 502 }
        );
    }
}