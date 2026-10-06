import type { LeqReport } from "./types.js";

function csvValue(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function reportToCsv(report: LeqReport): string {
  const header = [
    "report_id",
    "dataset_id",
    "dataset_name",
    "version",
    "unit",
    "window_start",
    "window_end",
    "window_duration_ms",
    "measured_duration_ms",
    "coverage_ratio",
    "coverage_percent",
    "status",
    "label",
    "measured_part_leq_db",
    "segment_id",
    "original_index",
    "source_start",
    "source_end",
    "intersection_start",
    "intersection_end",
    "intersection_duration_ms",
    "segment_leq_db",
    "linear_energy_weight",
    "relative_energy_contribution_percent",
    "gap_start",
    "gap_end",
    "gap_duration_ms",
  ];
  const rowCount = Math.max(report.contributions.length, report.gaps.length, 1);
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const contribution = report.contributions[index];
    const gap = report.gaps[index];
    return [
      report.reportId ?? "",
      report.datasetId,
      report.datasetName,
      report.version,
      report.referenceUnit,
      report.windowStart,
      report.windowEnd,
      report.windowDurationMs,
      report.measuredDurationMs,
      report.coverageRatio,
      report.coveragePercent,
      report.status,
      report.label,
      report.measuredPartLeqDbRounded6 ?? "",
      contribution?.segmentId ?? "",
      contribution?.originalIndex ?? "",
      contribution?.sourceStart ?? "",
      contribution?.sourceEnd ?? "",
      contribution?.intersectionStart ?? "",
      contribution?.intersectionEnd ?? "",
      contribution?.durationMs ?? "",
      contribution?.leqDb ?? "",
      contribution?.linearEnergyWeight ?? "",
      contribution?.relativeEnergyContributionPercent ?? "",
      gap?.start ?? "",
      gap?.end ?? "",
      gap?.durationMs ?? "",
    ].map(csvValue).join(",");
  });
  return [header.join(","), ...rows].join("\r\n");
}

export function reportToJson(report: LeqReport): string {
  return JSON.stringify(report, null, 2);
}
