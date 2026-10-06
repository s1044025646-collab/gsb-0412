import { AppError } from "./errors.js";
import type {
  Gap,
  InputSegment,
  LeqReport,
  SegmentContribution,
  StoredSegment,
} from "./types.js";

export const DEFAULT_MIN_DB = -100;
export const DEFAULT_MAX_DB = 200;
export const DEFAULT_MAX_SEGMENTS_PER_VERSION = 10_000;
export const DEFAULT_MAX_QUERY_SPAN_MS = 366 * 24 * 60 * 60 * 1000;
export const ROUND_DECIMALS = 6;

export function assertIntMs(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AppError("INVALID_TIME", `${field} 必须是安全整数毫秒。`, 400, { field });
  }
  return value;
}

export function validateWindow(start: unknown, end: unknown, maxSpanMs: number) {
  const s = assertIntMs(start, "start");
  const e = assertIntMs(end, "end");
  if (e <= s) {
    throw new AppError("INVALID_WINDOW", "查询窗口必须是左闭右开的正长度区间 [start,end)。", 400, {
      start: s,
      end: e,
    });
  }
  if (e - s > maxSpanMs) {
 throw new AppError("QUERY_SPAN_TOO_LARGE", `查询跨度不能超过 ${maxSpanMs} 毫秒。`, 400, {
      maxSpanMs,
    });
  }
  return { start: s, end: e };
}

export function normalizeAndValidateSegments(
  rawSegments: unknown,
  minDb: number,
  maxDb: number,
  maxSegments: number,
): StoredSegment[] {
  if (!Array.isArray(rawSegments)) {
    throw new AppError("INVALID_SEGMENTS", "segments 必须是数组。");
  }
  if (rawSegments.length === 0) {
    throw new AppError("EMPTY_BATCH", "批量导入至少需要一条时间段。");
  }
  if (rawSegments.length > maxSegments) {
    throw new AppError("TOO_MANY_SEGMENTS", `单个版本最多包含 ${maxSegments} 段。`, 400, {
      count: rawSegments.length,
      maxSegments,
    });
  }

  const normalized = rawSegments.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new AppError("INVALID_SEGMENT", `第 ${index} 段必须是对象。`, 400, { index });
    }
    const item = raw as Record<string, unknown>;
    const start = assertIntMs(item.start, `segments[${index}].start`);
    const end = assertIntMs(item.end, `segments[${index}].end`);
    const leqDb = item.leqDb;
    if (end <= start) {
      throw new AppError("NON_POSITIVE_DURATION", `第 ${index} 段时长必须为正。`, 400, {
        index,
        start,
        end,
      });
    }
    if (typeof leqDb !== "number" || !Number.isFinite(leqDb)) {
      throw new AppError("INVALID_DB", `第 ${index} 段声级必须是有限数。`, 400, { index });
    }
    if (leqDb < minDb || leqDb > maxDb) {
      throw new AppError("DB_OUT_OF_RANGE", `第 ${index} 段声级超出公开允许范围。`, 400, {
        index,
        leqDb,
        minDb,
        maxDb,
      });
    }
    const suppliedId = item.segmentId;
    if (
      suppliedId !== undefined &&
      suppliedId !== null &&
      typeof suppliedId !== "string" &&
      typeof suppliedId !== "number"
    ) {
      throw new AppError("INVALID_SEGMENT_ID", `第 ${index} 段编号必须是字符串或数字。`, 400, {
        index,
      });
    }
    const segmentId = suppliedId === undefined || suppliedId === null ? `auto-${index}` : String(suppliedId);
    return {
      segmentId,
      originalIndex: index,
      start,
      end,
      leqDb,
    } satisfies StoredSegment;
  });

  const duplicateIds = new Set<string>();
  const seenIds = new Set<string>();
  for (const segment of normalized) {
    if (seenIds.has(segment.segmentId)) duplicateIds.add(segment.segmentId);
    seenIds.add(segment.segmentId);
  }
  if (duplicateIds.size > 0) {
    throw new AppError("DUPLICATE_SEGMENT_ID", "段编号在同一批次中必须唯一。", 400, {
      duplicateSegmentIds: [...duplicateIds],
    });
  }

  assertNoOverlap(normalized, "批次内");
  return normalized;
}

export function assertNoOverlap(segments: InputSegment[], context: string) {
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (current.start < previous.end && current.end > previous.start) {
      throw new AppError("OVERLAPPING_SEGMENTS", `${context}存在重叠时间段，导入已整体拒绝。`, 409, {
        first: previous,
        second: current,
      });
    }
  }
}

function mergeIntervals(intervals: Array<{ start: number; end: number }>) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

export function buildReport(params: {
  datasetId: string;
  datasetName: string;
  version: number;
  windowStart: number;
  windowEnd: number;
  segments: StoredSegment[];
}): LeqReport {
  const { datasetId, datasetName, version, windowStart, windowEnd, segments } = params;
  const windowDuration = windowEnd - windowStart;
  const clipped: Array<StoredSegment & { intersectionStart: number; intersectionEnd: number }> = [];

  for (const segment of segments) {
    const intersectionStart = Math.max(segment.start, windowStart);
    const intersectionEnd = Math.min(segment.end, windowEnd);
    if (intersectionStart < intersectionEnd) {
      clipped.push({ ...segment, intersectionStart, intersectionEnd });
    }
  }
  clipped.sort((a, b) => a.intersectionStart - b.intersectionStart);

  const covered = mergeIntervals(
    clipped.map((segment) => ({ start: segment.intersectionStart, end: segment.intersectionEnd })),
  );
  const gaps: Gap[] = [];
  let cursor = windowStart;
  for (const interval of covered) {
    if (interval.start > cursor) gaps.push({ start: cursor, end: interval.start, durationMs: interval.start - cursor });
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < windowEnd) gaps.push({ start: cursor, end: windowEnd, durationMs: windowEnd - cursor });

  const measuredDuration = covered.reduce((sum, gap) => sum + (gap.end - gap.start), 0);
  const referenceMaxDb = clipped.length === 0 ? null : Math.max(...clipped.map((segment) => segment.leqDb));
  const scaledWeights = clipped.map((segment) => {
    const duration = segment.intersectionEnd - segment.intersectionStart;
    return duration * 10 ** ((segment.leqDb - (referenceMaxDb ?? 0)) / 10);
  });
  const totalScaledWeight = scaledWeights.reduce((sum, value) => sum + value, 0);
  const leq =
    measuredDuration > 0
      ? (referenceMaxDb ?? 0) + 10 * Math.log10(totalScaledWeight / measuredDuration)
      : null;

  const contributions: SegmentContribution[] = clipped.map((segment, index) => ({
    segmentId: segment.segmentId,
    originalIndex: segment.originalIndex,
    sourceStart: segment.start,
    sourceEnd: segment.end,
    intersectionStart: segment.intersectionStart,
    intersectionEnd: segment.intersectionEnd,
    durationMs: segment.intersectionEnd - segment.intersectionStart,
    leqDb: segment.leqDb,
    linearEnergyWeight:
      (segment.intersectionEnd - segment.intersectionStart) * 10 ** (segment.leqDb / 10),
    relativeEnergyContributionPercent:
      totalScaledWeight > 0 ? (scaledWeights[index] / totalScaledWeight) * 100 : 0,
  }));
  const unscaledTotal = contributions.reduce((sum, item) => sum + item.linearEnergyWeight, 0);
  const recomputed = measuredDuration > 0 ? 10 * Math.log10(unscaledTotal / measuredDuration) : null;
  const status = measuredDuration === 0 ? "NO_COVERAGE" : measuredDuration === windowDuration ? "COMPLETE" : "PARTIAL";
  const rounded = leq === null ? null : Number(leq.toFixed(ROUND_DECIMALS));

  return {
    datasetId,
    datasetName,
    version,
    referenceUnit: "dB",
    referenceQuantity: "same sound-pressure-level reference for every dataset",
    windowStart,
    windowEnd,
    windowDurationMs: windowDuration,
    measuredDurationMs: measuredDuration,
    coverageRatio: measuredDuration / windowDuration,
    coveragePercent: Number(((measuredDuration / windowDuration) * 100).toFixed(ROUND_DECIMALS)),
    gaps,
    status,
    label:
      status === "COMPLETE"
        ? "整个窗口等效声级 Leq"
        : status === "PARTIAL"
          ? "已测部分等效声级 Leq（窗口含缺测，不能代表整个窗口）"
          : "无结果：查询窗口没有任何测量覆盖",
    limitation:
      status === "COMPLETE"
        ? null
        : "交集部分按段内声能均匀分布估算；缺测时间既不按 0 dB 处理，也不外推。",
    measuredPartLeqDb: leq,
    measuredPartLeqDbRounded6: rounded,
    referenceMaxDb: referenceMaxDb ?? 0,
    totalLinearEnergyWeight: unscaledTotal,
    contributions,
    reconstruction: {
      formula: "10*log10(sum(durationMs*10^(leqDb/10))/measuredDurationMs)",
      recomputedLeqDb: recomputed === null ? null : Number(recomputed.toFixed(ROUND_DECIMALS)),
    },
  };
}
