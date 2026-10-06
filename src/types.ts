export interface InputSegment {
  segmentId?: string | number | null;
  start: number;
  end: number;
  leqDb: number;
}

export interface StoredSegment extends InputSegment {
  segmentId: string;
  originalIndex: number;
}

export interface SegmentContribution {
  segmentId: string;
  originalIndex: number;
  sourceStart: number;
  sourceEnd: number;
  intersectionStart: number;
  intersectionEnd: number;
  durationMs: number;
  leqDb: number;
  linearEnergyWeight: number;
  relativeEnergyContributionPercent: number;
}

export interface Gap {
  start: number;
  end: number;
  durationMs: number;
}

export interface QueryWindow {
  start: number;
  end: number;
  version?: number;
}

export type ReportStatus = "COMPLETE" | "PARTIAL" | "NO_COVERAGE";

export interface LeqReport {
  datasetId: string;
  datasetName: string;
  version: number;
  referenceUnit: "dB";
  referenceQuantity: "same sound-pressure-level reference for every dataset";
  windowStart: number;
  windowEnd: number;
  windowDurationMs: number;
  measuredDurationMs: number;
  coverageRatio: number;
  coveragePercent: number;
  gaps: Gap[];
  status: ReportStatus;
  label: string;
  limitation: string | null;
  measuredPartLeqDb: number | null;
  measuredPartLeqDbRounded6: number | null;
  referenceMaxDb: number;
  totalLinearEnergyWeight: number;
  contributions: SegmentContribution[];
  reconstruction: {
    formula: "10*log10(sum(durationMs*10^(leqDb/10))/measuredDurationMs)";
    recomputedLeqDb: number | null;
  };
  savedAt?: string;
  reportId?: number;
}

export interface DatasetRules {
  minDb: number;
  maxDb: number;
  maxSegmentsPerVersion: number;
  maxQuerySpanMs: number;
}

export interface DatasetRecord {
  id: string;
  name: string;
  current_version: number;
  rules_json: string;
  created_at: string;
}
