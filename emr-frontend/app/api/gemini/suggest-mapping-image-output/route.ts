import { GoogleGenAI } from "@google/genai";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { gzipSync } from "node:zlib";
import { z } from "zod";

export const maxDuration = 60;

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

// What we expect Gemini to return
const FieldSchema = z.object({
  page: z.number().int().min(1),
  type: z.string().default("text"), // text | text_area | checkbox | radio | date | comb | signature ...
  label: z.string().default(""),
  bbox: z.array(z.number()).length(4), // [x_min, y_min, x_max, y_max], 0-1000, top-left origin
  fill: z.string().nullable().default(null),
  chars: z.array(z.string()).nullish(), // comb fields
  segments: z.array(z.string()).nullish(), // segmented dates
  font_size: z.number().nullish(),
  source_paths: z.array(z.string()).default([]),
  match_status: z.string().default("matched"),
  confidence: z.number().nullish(),
  notes: z.string().nullish(),
});
const ModelOutput = z.object({ fields: z.array(FieldSchema) });
type Field = z.infer<typeof FieldSchema>;

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

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// Helvetica (WinAnsi) can't encode everything; replace what it can't.
const clean = (s: string) => s.replace(/[\r\t]+/g, " ").replace(/[^\n\x20-\x7E\xA0-\xFF]/g, "?");

function fitSize(font: PDFFont, text: string, maxW: number, startSize: number) {
  let size = startSize;
  while (size > 6 && font.widthOfTextAtSize(text, size) > maxW) size -= 0.5;
  return size;
}

function truncateToWidth(font: PDFFont, text: string, maxW: number, size: number) {
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(t, size) > maxW) t = t.slice(0, -1);
  return t;
}

function wrapLines(font: PDFFont, text: string, maxW: number, size: number) {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= maxW) {
        line = next;
      } else {
        if (line) lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawField(page: PDFPage, font: PDFFont, f: Field) {
  const { width: pw, height: ph } = page.getSize();
  const [a, b, c, d] = f.bbox.map((n) => clamp(n, 0, 1000));

  const x0 = (Math.min(a, c) / 1000) * pw;
  const x1 = (Math.max(a, c) / 1000) * pw;
  // convert top-left origin (0-1000) to PDF bottom-left origin (points)
  const yTop = ph - (Math.min(b, d) / 1000) * ph;
  const yBot = ph - (Math.max(b, d) / 1000) * ph;
  const w = x1 - x0;
  const h = yTop - yBot;
  if (w <= 0 || h <= 0) return;

  const color = rgb(0, 0, 0);
  const preferred = clamp(f.font_size ?? 10, 6, 12);

  // Character-comb: one character per cell
  if (f.chars?.length) {
    const cellW = w / f.chars.length;
    const size = clamp(Math.min(preferred, h * 0.85), 6, 12);
    f.chars.forEach((ch, i) => {
      const t = clean(ch ?? "");
      if (!t) return;
      const tw = font.widthOfTextAtSize(t, size);
      page.drawText(t, {
        x: x0 + i * cellW + (cellW - tw) / 2,
        y: yBot + (h - size) / 2 + size * 0.2,
        size,
        font,
        color,
      });
    });
    return;
  }

  // Segmented date: one part per equal-width segment
  if (f.segments?.length) {
    const segW = w / f.segments.length;
    f.segments.forEach((seg, i) => {
      const t = clean(seg ?? "");
      if (!t) return;
      const size = fitSize(font, t, segW - 2, clamp(Math.min(preferred, h * 0.85), 6, 12));
      const tw = font.widthOfTextAtSize(t, size);
      page.drawText(t, {
        x: x0 + i * segW + (segW - tw) / 2,
        y: yBot + (h - size) / 2 + size * 0.2,
        size,
        font,
        color,
      });
    });
    return;
  }

  if (!f.fill) return;
  const text = clean(f.fill);
  if (!text.trim()) return;

  // Checkbox / radio: centered mark
  if (f.type === "checkbox" || f.type === "radio") {
    const size = clamp(Math.min(w, h) * 0.9, 6, 14);
    const tw = font.widthOfTextAtSize(text, size);
    page.drawText(text, {
      x: x0 + (w - tw) / 2,
      y: yBot + (h - size) / 2 + size * 0.2,
      size,
      font,
      color,
    });
    return;
  }

  // Multi-line free text
  const multiLine = f.type === "text_area" || text.includes("\n") || h > preferred * 2.6;
  if (multiLine) {
    const size = preferred;
    const lineH = size * 1.2;
    const maxLines = Math.max(1, Math.floor(h / lineH));
    const lines = wrapLines(font, text, w - 2, size).slice(0, maxLines);
    lines.forEach((line, i) => {
      page.drawText(line, { x: x0 + 1, y: yTop - size - i * lineH, size, font, color });
    });
    return;
  }

  // Single line
  const size = fitSize(font, text, w - 2, clamp(Math.min(preferred, h * 0.9), 6, 12));
  const shown = truncateToWidth(font, text, w - 2, size);
  page.drawText(shown, {
    x: x0 + 1,
    y: yBot + (h - size) / 2 + size * 0.2,
    size,
    font,
    color,
  });
}

const BASE_PROMPT = `
    You are given a PDF form and an HL7 FHIR (JSON). 
    
    Create a PDF with the same format and use the information from the JSON 
    and match where it should go using the headers or context provided by the page. 

    Ensure no text overlays with any lines. If a section requires information not included in the JSON fill it out to the best
    of your ability or leave it blank completely. 

    Additionally to the PDF return a JSON matching this schema:
    {
    "fields": [
        {
        "page": 1,
        "type": "text" | "text_area" | "checkbox" | "radio" | "date" | "comb" | "signature",
        "label": "the printed label of the field",
        "bbox": [x_min, y_min, x_max, y_max],
        "fill": "text to print, or null",
        "chars": ["A","B"],
        "segments": ["MM","DD","YYYY"],
        "font_size": 10,
        "source_paths": ["Patient.birthDate"],
        "match_status": "matched" | "no_data" | "requires_human" | "uncertain",
        "confidence": 0.0-1.0,
        "notes": "optional"
        }
    ]
    "excluded": []
    }
    denoting every choice you made.
`;

const PROMPT = BASE_PROMPT;

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

  const pdfBytes = Buffer.from(await pdf.arrayBuffer());

  // 1) Ask Gemini for the field mapping
  let mapping: z.infer<typeof ModelOutput>;
  try {
    const result = await ai.models.generateContent({
      model: "gemini-3.5-flash-lite", //newest standard flash model
      contents: [
        { inlineData: { mimeType: "application/pdf", data: pdfBytes.toString("base64") } },
        { text: `FHIR R4 DATA (${fhirIsJson ? "JSON" : "XML"}):\n${fhirText}` },
        { text: PROMPT },
      ],
      config: { responseMimeType: "application/json" },
    });

    const raw = (result.text ?? "")
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
    const out = ModelOutput.safeParse(JSON.parse(raw));
    if (!out.success) throw new Error("The model returned an unexpected format");
    mapping = out.data;
  } catch (e) {
    console.error("Gemini error:", e);
    return Response.json(
      { error: e instanceof Error ? e.message : "Gemini request failed" },
      { status: 502 }
    );
  }

  // 2) Draw the values onto the PDF
  let filled: Uint8Array;
  try {
    const doc = await PDFDocument.load(pdfBytes);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();

    for (const f of mapping.fields) {
      const page = pages[f.page - 1];
      if (!page) continue;
      drawField(page, font, f);
    }
    filled = await doc.save();
  } catch (e) {
    console.error("PDF error:", e);
    return Response.json(
      { error: "Couldn't write to that PDF. It may be encrypted or damaged." },
      { status: 422 }
    );
  }

  // 3) Return the PDF; the mapping travels in a gzipped, base64 header
  const mappingHeader = gzipSync(Buffer.from(JSON.stringify(mapping))).toString("base64");

  return new Response(Buffer.from(filled), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="filled.pdf"',
      "X-Field-Mapping": mappingHeader,
      "Access-Control-Expose-Headers": "X-Field-Mapping",
      "Cache-Control": "no-store",
    },
  });
}