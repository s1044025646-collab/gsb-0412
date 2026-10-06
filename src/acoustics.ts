import { AppError } from "./errors.js";
import type { Limits } from "./config.js";
import { DEFAULT_LIMITS } from "./config.js";

/** 输入段（原始段编号由调用方保证保留）。 */
export interface InputSegment {
  /** 原始段编号：导入时由调用方提供，规范化排序后仍原样回传。 */
  segId: number;
  startMs: number;
  endMs: number;
  levelDb: number;
}

export interface QueryWindow {
  startMs: number;
  endMs: number;
}

export interface Gap {
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface SegmentContribution {
  segId: number;
  originalStartMs: number;
  originalEndMs: number;
  originalDurationMs: number;
  levelDb: number;
  overlapStartMs: number;
  overlapEndMs: number;
  overlapDurationMs: number;
  /** 时长权重 = 交集时长 / 窗口总时长。 */
  durationWeight: number;
  /** 相对能量贡献占比（0~1），所有贡献之和为 1。 */
  energyFraction: number;
  /** 该交集的缩放后能量项 overlapMs * 10^(level/10) / 10^(refMax/10)。 */
  scaledEnergy: number;
}

export interface LeqReport {
  pointId: string;
  version: number;
  windowStartMs: number;
  windowEndMs: number;
  windowDurationMs: number;
  coveredDurationMs: number;
  coverageRatio: number;
  gaps: Gap[];
  contributions: SegmentContribution[];
  /** 已测部分等效声级；无覆盖时为 null（绝不返回零 dB）。 */
  leqDb: number | null;
  referenceMaxLevelDb: number | null;
  /** complete = 窗口被已测数据完整覆盖；partial = 存在缺测。 */
  completeness: "complete" | "partial" | "empty";
  /** 面向导出/展示的标签，缺测时明确保留限制说明。 */
  label: string;
  notes: string[];
  rules: {
    unit: string;
    intervalConvention: string;
    intraSegmentAssumption: string;
    formula: string;
  };
}

function assertSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AppError("INVALID_PARAM", `${name} 必须是安全整数毫秒值`, { received: String(value) });
  }
  return value;
}

/** 校验一条原始段：左闭右开、正长度、声级为范围内有限数。不允许 NaN/Infinity。 */
export function validateSegment(
  raw: Partial<InputSegment>,
  index: number,
  limits: Limits = DEFAULT_LIMITS,
): InputSegment {
  const segId = raw.segId;
  if (typeof segId !== "number" || !Number.isSafeInteger(segId) || segId < 0) {
    throw new AppError(
      "INVALID_PARAM",
      `第 ${index} 条段编号 segId 必须是非负安全整数`,
      { index, received: String(segId) },
    );
  }
  const startMs = assertSafeInteger(raw.startMs, `第 ${index} 条 startMs`);
  const endMs = assertSafeInteger(raw.endMs, `第 ${index} 条 endMs`);
  if (endMs <= startMs) {
    throw new AppError("INVALID_RANGE", `第 ${index} 条时间段长度必须为正（左闭右开 endMs > startMs）`, {
      index,
      segId,
      startMs,
      endMs,
    });
  }
  const levelDb = raw.levelDb;
  if (typeof levelDb !== "number" || !Number.isFinite(levelDb)) {
    throw new AppError("INVALID_PARAM", `第 ${index} 条声级 levelDb 必须是有限数，禁止 NaN/Infinity`, {
      index,
      segId,
      received: String(levelDb),
    });
  }
  if (levelDb < limits.minLevelDb || levelDb > limits.maxLevelDb) {
    throw new AppError(
      "INVALID_RANGE",
      `第 ${index} 条声级 ${levelDb} dB 超出公开允许范围 [${limits.minLevelDb}, ${limits.maxLevelDb}] dB`,
      { index, segId, levelDb, allowed: [limits.minLevelDb, limits.maxLevelDb] },
    );
  }
  return { segId, startMs, endMs, levelDb };
}

export function validateWindow(raw: Partial<QueryWindow>, limits: Limits = DEFAULT_LIMITS): QueryWindow {
  const startMs = assertSafeInteger(raw.startMs, "startMs");
  const endMs = assertSafeInteger(raw.endMs, "endMs");
  if (endMs <= startMs) {
    throw new AppError("INVALID_RANGE", "查询窗口长度必须为正（左闭右开 endMs > startMs）", {
      startMs,
      endMs,
    });
  }
  const span = endMs - startMs;
  if (span > limits.maxWindowSpanMs) {
    throw new AppError("LIMIT_EXCEEDED", `查询窗口跨度 ${span} ms 超过限制 ${limits.maxWindowSpanMs} ms`, {
      spanMs: span,
      limitMs: limits.maxWindowSpanMs,
    });
  }
  return { startMs, endMs };
}

/**
 * 检测同测点段集合内部是否存在重叠。
 * 左闭右开：仅端点相接（prev.end === next.start）视为相邻，允许。
 * 返回重叠对（按排序后下标）；空数组表示无冲突。
 */
export function findOverlaps(
  segments: InputSegment[],
): { a: InputSegment; b: InputSegment }[] {
  const sorted = [...segments].sort((x, y) => x.startMs - y.startMs || x.endMs - y.endMs);
  const conflicts: { a: InputSegment; b: InputSegment }[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    if (curr.startMs < prev.endMs) {
      conflicts.push({ a: prev, b: curr });
    }
  }
  return conflicts;
}

/** 与既有段检测重叠（批量导入前调用）。 */
export function assertNoOverlap(existing: InputSegment[], incoming: InputSegment[]): void {
  const conflicts = findOverlaps([...existing, ...incoming]);
  if (conflicts.length > 0) {
    const first = conflicts[0]!;
    throw new AppError(
      "OVERLAP_CONFLICT",
      `检测到时间段重叠：seg ${first.a.segId} 与 seg ${first.b.segId} 重叠；同测点不允许重叠，整批拒绝`,
      {
        conflicts: conflicts.slice(0, 20).map((c) => ({
          segA: c.a.segId,
          segB: c.b.segId,
          a: [c.a.startMs, c.a.endMs],
          b: [c.b.startMs, c.b.endMs],
        })),
        totalConflicts: conflicts.length,
      },
    );
  }
}

/** 稳定计算 10^(db/10)。仅用于内部运算，结果不得落库为声级。 */
export function linearEnergy(levelDb: number): number {
  return Math.pow(10, levelDb / 10);
}

const RULES = {
  unit: "dB（全部测点相同参考量；参考量本身不改变 Leq 计算）",
  intervalConvention: "左闭右开 [startMs, endMs)，相邻端点不重复计时，时间单位整数毫秒",
  intraSegmentAssumption:
    "段内声能均匀分布：窗口从段中间开始/结束时，按交集时长占比分摊该段能量，属假设估算而非更细采样真实测量",
  formula:
    "Leq = 10*log10( Σ(overlapMs_i * 10^(levelDb_i/10)) / Σ(overlapMs_i) )，仅对已测交集计时，缺测不计零 dB",
};

/**
 * 核心汇总。返回完整报告：裁剪交集、缺口、覆盖比例、已测部分 Leq、可回算的相对能量贡献。
 * 采用参考最大声级缩放：scaledE_i = w_i * 10^((L_i-L_ref)/10)，
 * Leq = L_ref + 10*log10(ΣscaledE_i / Σw_i)，数学上与直接线性能量完全等价。
 */
export function summarizeWindow(
  pointId: string,
  version: number,
  segments: InputSegment[],
  window: QueryWindow,
): LeqReport {
  const notes: string[] = [];
  const windowDuration = window.endMs - window.startMs;

  const clipped: { seg: InputSegment; overlapStart: number; overlapEnd: number; overlapMs: number }[] = [];
  for (const seg of segments) {
    const overlapStart = Math.max(seg.startMs, window.startMs);
    const overlapEnd = Math.min(seg.endMs, window.endMs);
    if (overlapStart < overlapEnd) {
      clipped.push({ seg, overlapStart, overlapEnd, overlapMs: overlapEnd - overlapStart });
    }
  }
  clipped.sort((a, b) => a.overlapStart - b.overlapStart || a.seg.segId - b.seg.segId);

  // 缺口：交集之间的未覆盖区间（交集本身互不为重叠，因为导入时已拒绝重叠）。
  const gaps: Gap[] = [];
  let cursor = window.startMs;
  for (const c of clipped) {
    if (c.overlapStart > cursor) {
      gaps.push({ startMs: cursor, endMs: c.overlapStart, durationMs: c.overlapStart - cursor });
    }
    cursor = Math.max(cursor, c.overlapEnd);
  }
  if (cursor < window.endMs) {
    gaps.push({ startMs: cursor, endMs: window.endMs, durationMs: window.endMs - cursor });
  }

  const coveredDuration = clipped.reduce((sum, c) => sum + c.overlapMs, 0);
  const coverageRatio = windowDuration === 0 ? 0 : coveredDuration / windowDuration;

  let leqDb: number | null = null;
  let referenceMaxLevelDb: number | null = null;
  let contributions: SegmentContribution[] = [];
  let completeness: LeqReport["completeness"];
  let label: string;

  if (clipped.length === 0 || coveredDuration <= 0) {
    completeness = "empty";
    label = "无结果：窗口内完全没有已测数据（缺测，不能解释为 0 dB）";
    notes.push("窗口与任何已给时间段无交集，不返回声级值。");
  } else {
    referenceMaxLevelDb = Math.max(...clipped.map((c) => c.seg.levelDb));
    const scaled = clipped.map((c) => ({
      ...c,
      scaledEnergy: c.overlapMs * Math.pow(10, (c.seg.levelDb - referenceMaxLevelDb!) / 10),
    }));
    const totalScaled = scaled.reduce((sum, s) => sum + s.scaledEnergy, 0);
    if (!Number.isFinite(totalScaled) || totalScaled <= 0) {
      throw new AppError("INVALID_PARAM", "能量求和出现非有限值，拒绝生成结果", { totalScaled });
    }
    leqDb = referenceMaxLevelDb + 10 * Math.log10(totalScaled / coveredDuration);
    if (!Number.isFinite(leqDb)) {
      throw new AppError("INVALID_PARAM", "Leq 计算结果非有限数（NaN/Infinity），拒绝保存", { leqDb });
    }

    contributions = scaled.map<SegmentContribution>((s) => ({
      segId: s.seg.segId,
      originalStartMs: s.seg.startMs,
      originalEndMs: s.seg.endMs,
      originalDurationMs: s.seg.endMs - s.seg.startMs,
      levelDb: s.seg.levelDb,
      overlapStartMs: s.overlapStart,
      overlapEndMs: s.overlapEnd,
      overlapDurationMs: s.overlapMs,
      durationWeight: s.overlapMs / windowDuration,
      energyFraction: s.scaledEnergy / totalScaled,
      scaledEnergy: s.scaledEnergy,
    }));

    if (gaps.length === 0) {
      completeness = "complete";
      label = `完整窗口汇总 Leq = ${leqDb.toFixed(4)} dB（窗口已 100% 覆盖）`;
    } else {
      completeness = "partial";
      label = `已测部分 Leq = ${leqDb.toFixed(4)} dB（仅供已覆盖 ${(coverageRatio * 100).toFixed(2)}% 部分，存在 ${gaps.length} 个缺测区间，不能代表整个窗口）`;
      notes.push("存在缺测：Leq 仅覆盖已测交集时长，缺口不按 0 dB 计，也未做任何插补。");
    }

    // 内部不变量：缺口时长 + 覆盖时长必须恰等于窗口时长。
    const gapTotal = gaps.reduce((s, g) => s + g.durationMs, 0);
    if (gapTotal + coveredDuration !== windowDuration) {
      throw new AppError("INVALID_PARAM", "内部校验失败：缺口时长 + 覆盖时长 ≠ 窗口时长", {
        gapTotal,
        coveredDuration,
        windowDuration,
      });
    }
    // 回算不变量：由各贡献的时长权重与声级重新合成，应与报告 Leq 一致。
    const back =
      referenceMaxLevelDb +
      10 *
        Math.log10(
          contributions.reduce((sum, c) => sum + c.scaledEnergy, 0) / coveredDuration,
        );
    if (!Number.isFinite(back) || Math.abs(back - leqDb) > 1e-9) {
      throw new AppError("INVALID_PARAM", "内部校验失败：贡献回算 Leq 与报告不一致", { back, leqDb });
    }
  }

  return {
    pointId,
    version,
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
    windowDurationMs: windowDuration,
    coveredDurationMs: coveredDuration,
    coverageRatio,
    gaps,
    contributions,
    leqDb,
    referenceMaxLevelDb,
    completeness,
    label,
    notes,
    rules: RULES,
  };
}
