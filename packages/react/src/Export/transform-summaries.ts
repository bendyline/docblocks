export interface ExportSummaryOption {
  id: string;
  name: string;
  description?: string;
}

let transformStyleSummariesPromise: Promise<ExportSummaryOption[]> | null = null;

export function loadTransformStyleSummaries(): Promise<ExportSummaryOption[]> {
  transformStyleSummariesPromise ??= import('@bendyline/squisq/transform').then(
    ({ getTransformStyleSummaries }) => getTransformStyleSummaries(),
  );
  return transformStyleSummariesPromise;
}
