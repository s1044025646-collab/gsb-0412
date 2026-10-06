import { DatabaseSync } from "node:sqlite";

export const REFERENCE_UNIT = "dB";

/**
 * 公开可接受的声级范围（dB，有限数；负 dB 本身允许，只要在范围内）。
 * 时间一律为整数毫秒；查询跨度与段数有限制。
 */
export const MIN_LEVEL_DB = -100;
export const MAX_LEVEL_DB = 200;
export const MAX_SEGMENTS_PER_POINT = 100_000;
export const MAX_BATCH_SIZE = 10_000;
export const MAX_WINDOW_SPAN_MS = 365 * 24 * 3600 * 1000; // 1 年

/** 稳定缩放：以批内参考最大声级为基准，避免巨大线性声能直接参与运算。 */
export const SCALE_OFFSET_EPSILON = 1e-12;

export interface Limits {
  minLevelDb: number;
  maxLevelDb: number;
  maxSegmentsPerPoint: number;
  maxBatchSize: number;
  maxWindowSpanMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  minLevelDb: MIN_LEVEL_DB,
  maxLevelDb: MAX_LEVEL_DB,
  maxSegmentsPerPoint: MAX_SEGMENTS_PER_POINT,
  maxBatchSize: MAX_BATCH_SIZE,
  maxWindowSpanMs: MAX_WINDOW_SPAN_MS,
};

/** 数据目录与数据库文件默认位于项目内，可由环境变量覆盖。 */
export function dataDir(): string {
  return process.env.LEQ_DATA_DIR ?? "data";
}

export function dbPath(): string {
  return process.env.LEQ_DB_PATH ?? `${dataDir()}/leq.sqlite`;
}

export function openDatabase(path: string = dbPath()): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}
