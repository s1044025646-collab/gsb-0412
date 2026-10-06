import type { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDatabase, REFERENCE_UNIT } from "./config.js";
import { AppError } from "./errors.js";
import type { InputSegment, LeqReport } from "./acoustics.js";

export interface PointRow {
  id: string;
  name: string | null;
  current_version: number;
  unit: string;
  created_at_ms: number;
}

export interface StoredSegment extends InputSegment {
  point_id: string;
  version: number;
  ordinal: number;
}

let MIGRATED = false;

export function initDatabase(path?: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path ?? "data/leq.sqlite"), { recursive: true });
  }
  const db = openDatabase(path);
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  if (MIGRATED) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS points (
      id TEXT PRIMARY KEY,
      name TEXT,
      current_version INTEGER NOT NULL DEFAULT 0,
      unit TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS segments (
      point_id TEXT NOT NULL REFERENCES points(id),
      version INTEGER NOT NULL,
      seg_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      level_db REAL NOT NULL,
      PRIMARY KEY (point_id, version, seg_id)
    );
    CREATE INDEX IF NOT EXISTS idx_segments_lookup
      ON segments(point_id, version, start_ms, end_ms);
    CREATE TABLE IF NOT EXISTS queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      point_id TEXT NOT NULL REFERENCES points(id),
      version INTEGER NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      query_id INTEGER PRIMARY KEY REFERENCES queries(id),
      completeness TEXT NOT NULL,
      window_duration_ms INTEGER NOT NULL,
      covered_duration_ms INTEGER NOT NULL,
      coverage_ratio REAL NOT NULL,
      leq_db REAL,
      reference_max_level_db REAL,
      label TEXT NOT NULL,
      report_json TEXT NOT NULL
    );
  `);
  MIGRATED = true;
}

/** 测试需要对多个内存库迁移时重置标记。 */
export function resetMigrationFlag(): void {
  MIGRATED = false;
}

export function createPoint(db: DatabaseSync, id: string, name: string | null): PointRow {
  const existing = db.prepare("SELECT id FROM points WHERE id = ?").get(id);
  if (existing) {
    throw new AppError("INVALID_PARAM", `测点数据集 ${id} 已存在`, { pointId: id });
  }
  db.prepare(
    "INSERT INTO points(id, name, current_version, unit, created_at_ms) VALUES(?, ?, 0, ?, ?)",
  ).run(id, name, REFERENCE_UNIT, Date.now());
  return getPoint(db, id);
}

export function getPoint(db: DatabaseSync, id: string): PointRow {
  const row = db
    .prepare("SELECT id, name, current_version, unit, created_at_ms FROM points WHERE id = ?")
    .get(id) as unknown as PointRow | undefined;
  if (!row) {
    throw new AppError("NOT_FOUND", `测点数据集不存在: ${id}`, { pointId: id });
  }
  return row;
}

export function listPoints(db: DatabaseSync): PointRow[] {
  return db
    .prepare("SELECT id, name, current_version, unit, created_at_ms FROM points ORDER BY id")
    .all() as unknown as PointRow[];
}

export function getSegments(db: DatabaseSync, pointId: string, version: number): StoredSegment[] {
  return db
    .prepare(
      `SELECT point_id AS pointId, version, seg_id AS segId, ordinal,
              start_ms AS startMs, end_ms AS endMs, level_db AS levelDb
       FROM segments WHERE point_id = ? AND version = ?
       ORDER BY start_ms, end_ms, seg_id`,
    )
    .all(pointId, version) as unknown as StoredSegment[];
}

export interface ImportResult {
  pointId: string;
  version: number;
  imported: number;
  totalInVersion: number;
}

/**
 * 原子批量导入：任何一条坏值/重叠都整体回滚，绝不部分写入。
 * segId 由调用方提供（保留原始编号）；ordinal 记录导入批次内顺序。
 * 写入后建立新版本快照（旧版本段原样保留，历史报告可复现）。
 */
export function importSegments(
  db: DatabaseSync,
  pointId: string,
  segments: InputSegment[],
): ImportResult {
  const point = getPoint(db, pointId);
  const existing = getSegments(db, point.id, point.current_version);
  const incomingIds = new Set(segments.map((s) => s.segId));
  for (const seg of existing) {
    if (incomingIds.has(seg.segId)) {
      throw new AppError(
        "OVERLAP_CONFLICT",
        `段编号 ${seg.segId} 在测点 ${pointId} 当前版本已存在；同一版本内 segId 必须唯一，整批拒绝`,
        { segId: seg.segId },
      );
    }
  }

  const newVersion = point.current_version + 1;
  const insertIncoming = db.prepare(
    "INSERT INTO segments(point_id, version, seg_id, ordinal, start_ms, end_ms, level_db) VALUES(?, ?, ?, ?, ?, ?, ?)",
  );
  const copyExisting = db.prepare(
    `INSERT INTO segments(point_id, version, seg_id, ordinal, start_ms, end_ms, level_db)
     SELECT ?, ?, seg_id, ordinal, start_ms, end_ms, level_db FROM segments
     WHERE point_id = ? AND version = ?`,
  );
  const bump = db.prepare("UPDATE points SET current_version = ? WHERE id = ?");

  const tx = db.exec.bind(db);
  void tx;
  db.exec("BEGIN IMMEDIATE");
  try {
    copyExisting.run(pointId, newVersion, pointId, point.current_version);
    segments.forEach((seg, index) => {
      insertIncoming.run(
        pointId,
        newVersion,
        seg.segId,
        index,
        seg.startMs,
        seg.endMs,
        seg.levelDb,
      );
    });
    bump.run(newVersion, pointId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return {
    pointId,
    version: newVersion,
    imported: segments.length,
    totalInVersion: getSegments(db, pointId, newVersion).length,
  };
}

/** 持久化查询参数与报告，返回 queryId。报告 JSON 含贡献与缺口，重启后可复现。 */
export function saveQueryAndReport(db: DatabaseSync, report: LeqReport): number {
  const now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const info = db
      .prepare(
        "INSERT INTO queries(point_id, version, start_ms, end_ms, created_at_ms) VALUES(?, ?, ?, ?, ?)",
      )
      .run(
        report.pointId,
        report.version,
        report.windowStartMs,
        report.windowEndMs,
        now,
      );
    const queryId = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO reports(query_id, completeness, window_duration_ms, covered_duration_ms,
         coverage_ratio, leq_db, reference_max_level_db, label, report_json)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      queryId,
      report.completeness,
      report.windowDurationMs,
      report.coveredDurationMs,
      report.coverageRatio,
      report.leqDb,
      report.referenceMaxLevelDb,
      report.label,
      JSON.stringify(report),
    );
    db.exec("COMMIT");
    return queryId;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface StoredReport {
  queryId: number;
  pointId: string;
  version: number;
  startMs: number;
  endMs: number;
  createdAtMs: number;
  completeness: string;
  leqDb: number | null;
  label: string;
  report: LeqReport;
}

export function getReport(db: DatabaseSync, queryId: number): StoredReport {
  const row = db
    .prepare(
      `SELECT q.id AS queryId, q.point_id AS pointId, q.version AS version,
              q.start_ms AS startMs, q.end_ms AS endMs, q.created_at_ms AS createdAtMs,
              r.completeness AS completeness, r.leq_db AS leqDb, r.label AS label,
              r.report_json AS reportJson
       FROM queries q JOIN reports r ON r.query_id = q.id WHERE q.id = ?`,
    )
    .get(queryId) as unknown as
    | (Omit<StoredReport, "report"> & { reportJson: string })
    | undefined;
  if (!row) {
    throw new AppError("NOT_FOUND", `报告不存在: queryId=${queryId}`, { queryId });
  }
  const { reportJson, ...rest } = row;
  return { ...rest, report: JSON.parse(reportJson) as LeqReport };
}
