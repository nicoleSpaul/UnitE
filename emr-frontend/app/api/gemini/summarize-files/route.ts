import { GoogleGenAI, type Part } from "@google/genai";

const MIME_TYPES: Record<string, string> = {
    pdf: "application/pdf",
    txt: "text/plain",
    csv: "text/csv",
    md: "text/markdown",
    json: "application/json",
    xml: "application/xml",
    cda: "application/xml",
    html: "text/html",
    htm: "text/html",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
};

export async function POST(req: Request) {
    let formData: FormData;
    try {
        formData = await req.formData();
    } catch {
        return Response.json({ error: "Send the files as multipart form data." }, { status: 400 });
    }

    const entries = formData.getAll("myFile");
    if (!entries.length || entries.some((entry) => typeof entry === "string" || entry.size === 0)) {
        return Response.json({ error: "Choose at least one non-empty file." }, { status: 400 });
    }
    const files = entries as File[];
    if (files.length > 10) {
        return Response.json({ error: "Choose up to 10 files." }, { status: 413 });
    }

    const mimeTypes = files.map((file) => MIME_TYPES[file.name.split(".").pop()?.toLowerCase() ?? ""]);
    if (mimeTypes.some((mimeType) => !mimeType)) {
        return Response.json({ error: "Unsupported file type. Use PDF, text, CSV, Markdown, JSON, XML, HTML, PNG, JPEG, or WebP." }, { status: 415 });
    }
    const prompt = `Summarize these files in clearly for text to speech.
Identify each filename and its main points. Do not add new details.`;

    try {
        const parts: Part[] = [{ text: prompt }];
        for (const [index, file] of files.entries()) {
            const mimeType = mimeTypes[index];
            parts.push({ text: `File ${index + 1}, filename: ${JSON.stringify(file.name)}` });
            if (mimeType === "application/pdf" || mimeType.startsWith("image/")) {
                parts.push({ inlineData: { mimeType, data: Buffer.from(await file.arrayBuffer()).toString("base64") } });
            } else {
                parts.push({ text: await file.text() });
            }
        }

        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
        const result = await ai.models.generateContent({
            model: "gemini-3.5-flash-lite",
            contents: [{ role: "user", parts }],
        });
        const summary = result.text?.trim();
        if (!summary) {
            return Response.json({ error: "No summary was returned. Please try again." }, { status: 502 });
        }
        return Response.json({ summary });
    } catch (e) {
        console.error("Gemini error:", e);
        return Response.json(
            { error: e instanceof Error ? e.message : "Gemini request failed" },
            { status: 502 }
        );
    }
}
