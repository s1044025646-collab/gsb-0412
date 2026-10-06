import type { DatabaseSync } from "node:sqlite";
import {
  createPoint,
  getPoint,
  getReport,
  getSegments,
  importSegments,
  initDatabase,
  listPoints,
  saveQueryAndReport,
  type ImportResult,
  type StoredReport,
} from "./db.js";
import {
  assertNoOverlap,
  summarizeWindow,
  validateSegment,
  validateWindow,
  type InputSegment,
  type LeqReport,
  type QueryWindow,
} from "./acoustics.js";
import { DEFAULT_LIMITS, type Limits } from "./config.js";
import { AppError } from "./errors.js";

export interface RawSegmentInput {
  segId?: unknown;
  startMs?: unknown;
  endMs?: unknown;
  levelDb?: unknown;
}

export class LeqService {
  readonly db: DatabaseSync;
  readonly limits: Limits;

  constructor(dbPath?: string, limits: Limits = DEFAULT_LIMITS) {
    this.db = initDatabase(dbPath);
    this.limits = limits;
  }

  createPoint(id: unknown, name?: unknown): { id: string; name: string | null } {
    if (typeof id !== "string" || !/^[A-Za-z0-9_\-.]{1,64}$/.test(id)) {
      throw new AppError(
        "INVALID_PARAM",
        "pointId 必须为 1~64 位字母数字及 _-. 的字符串",
        { received: String(id) },
      );
    }
    if (name !== undefined && name !== null && typeof name !== "string") {
      throw new AppError("INVALID_PARAM", "name 必须是字符串或 null", { received: String(name) });
    }
    return createPoint(this.db, id, name === undefined ? null : name ?? null);
  }

  listPoints() {
    return listPoints(this.db);
  }

  /**
   * 批量导入：先全量校验（坏值/重叠），再在单个事务内写入新版本。
   * 任一条失败 -> BATCH_REJECTED/OVERLAP_CONFLICT，不发生部分覆盖。
   * segId 缺省时自动按批次下标顺序编号（显式给出的原始编号始终保留）。
   */
  importBatch(
    pointId: unknown,
    rawSegments: unknown,
    options: { autoSegId?: boolean } = {},
  ): ImportResult {
    if (typeof pointId !== "string") {
      throw new AppError("INVALID_PARAM", "pointId 必须是字符串", { received: String(pointId) });
    }
    const point = getPoint(this.db, pointId);
    if (!Array.isArray(rawSegments)) {
      throw new AppError("INVALID_PARAM", "segments 必须是数组", { received: typeof rawSegments });
    }
    if (rawSegments.length === 0) {
      throw new AppError("INVALID_PARAM", "批次不能为空");
    }
    if (rawSegments.length > this.limits.maxBatchSize) {
      throw new AppError(
        "LIMIT_EXCEEDED",
        `批次数 ${rawSegments.length} 超过单次上限 ${this.limits.maxBatchSize}`,
        { batchSize: rawSegments.length, limit: this.limits.maxBatchSize },
      );
    }

    const incoming: InputSegment[] = rawSegments.map((raw, index) => {
      if (typeof raw !== "object" || raw === null) {
        throw new AppError("INVALID_PARAM", `第 ${index} 条段必须是对象`, { index });
      }
      const r = raw as RawSegmentInput;
      const segId: unknown = r.segId === undefined && options.autoSegId ? index : r.segId;
      return validateSegment(
        {
          segId: segId as number,
          startMs: r.startMs as number,
          endMs: r.endMs as number,
          levelDb: r.levelDb as number,
        },
        index,
        this.limits,
      );
    });

    const segIdSet = new Set<number>();
    for (const seg of incoming) {
      if (segIdSet.has(seg.segId)) {
        throw new AppError("BATCH_REJECTED", `批次内 segId ${seg.segId} 重复，整批拒绝`, {
          segId: seg.segId,
        });
      }
      segIdSet.add(seg.segId);
    }

    const projectedCount =
      getSegments(this.db, point.id, point.current_version).length + incoming.length;
    if (projectedCount > this.limits.maxSegmentsPerPoint) {
      throw new AppError(
        "LIMIT_EXCEEDED",
        `导入后段数 ${projectedCount} 超过单测点上限 ${this.limits.maxSegmentsPerPoint}`,
        { projected: projectedCount, limit: this.limits.maxSegmentsPerPoint },
      );
    }

    // 批内 + 与既有版本的重叠检测；任一冲突整体拒绝。
    assertNoOverlap(getSegments(this.db, point.id, point.current_version), incoming);

    return importSegments(this.db, point.id, incoming);
  }

  /** 仅校验区间（不写库）：返回规范化排序结果或抛出冲突错误。 */
  validateIntervals(rawSegments: unknown): { ok: true; count: number; normalized: InputSegment[] } {
    if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
      throw new AppError("INVALID_PARAM", "segments 必须是非空数组");
    }
    const segments = (rawSegments as RawSegmentInput[]).map((raw, index) =>
      validateSegment(
        {
          segId: raw.segId === undefined ? index : (raw.segId as number),
          startMs: raw.startMs as number,
          endMs: raw.endMs as number,
          levelDb: raw.levelDb as number,
        },
        index,
        this.limits,
      ),
    );
    assertNoOverlap([], segments);
    const normalized = [...segments].sort((a, b) => a.startMs - b.startMs || a.segId - b.segId);
    return { ok: true, count: segments.length, normalized };
  }

  queryWindow(
    pointId: unknown,
    rawWindow: unknown,
    options: { version?: unknown; persist?: boolean } = {},
  ): LeqReport & { queryId?: number } {
    if (typeof pointId !== "string") {
      throw new AppError("INVALID_PARAM", "pointId 必须是字符串");
    }
    const point = getPoint(this.db, pointId);
    let version = point.current_version;
    if (options.version !== undefined) {
      if (
        typeof options.version !== "number" ||
        !Number.isSafeInteger(options.version) ||
        options.version < 0
      ) {
        throw new AppError("INVALID_PARAM", "version 必须是非负安全整数");
      }
      if (options.version > point.current_version) {
        throw new AppError(
          "NOT_FOUND",
          `版本 ${options.version} 不存在，当前最新版本为 ${point.current_version}`,
        );
      }
      version = options.version;
    }
    if (typeof rawWindow !== "object" || rawWindow === null) {
      throw new AppError("INVALID_PARAM", "窗口必须是 {startMs,endMs} 对象");
    }
    const w = rawWindow as Partial<QueryWindow>;
    const window = validateWindow({ startMs: w.startMs, endMs: w.endMs }, this.limits);
    const segments = getSegments(this.db, point.id, version);
    const report = summarizeWindow(point.id, version, segments, window);
    if (options.persist) {
      const queryId = saveQueryAndReport(this.db, report);
      return { ...report, queryId };
    }
    return report;
  }

  getReport(queryId: unknown): StoredReport {
    if (
      typeof queryId !== "number" ||
      !Number.isSafeInteger(queryId) ||
      queryId <= 0
    ) {
      throw new AppError("INVALID_PARAM", "queryId 必须是正整数");
    }
    return getReport(this.db, queryId);
  }
}
