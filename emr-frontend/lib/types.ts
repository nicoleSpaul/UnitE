export type FhirResource = { resourceType: string; id: string;[k: string]: unknown };
export type ImportResult = { bundle: object; notes: string[]; patients: number };

export const toBundle = (resources: FhirResource[]) => ({
    resourceType: "Bundle",
    type: "collection",
    entry: resources.map((resource) => ({ resource })),
});

export type FhirBundle = {
    resourceType: "Bundle";
    type: string;
    entry?: { resource?: FhirResource }[];
};

export type ExportResult = { blob: Blob; filename: string; notes: string[] };
export type Exporter = (bundle: FhirBundle, baseName: string) => ExportResult;