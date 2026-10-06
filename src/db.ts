import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_MAX_QUERY_SPAN_MS,
  DEFAULT_MAX_SEGMENTS_PER_VERSION,
  DEFAULT_MAX_DB,
  DEFAULT_MIN_DB,
  assertNoOverlap,
  buildReport,
  normalizeAndValidateSegments,
  validateWindow,
} from "./core.js";
import { AppError } from "./errors.js";
import type { DatasetRecord, DatasetRules, InputSegment, LeqReport, StoredSegment } from "./types.js";

export interface CreateDatasetOptions {
  id?: string;
  name: string;
  rules?: Partial<DatasetRules>;
}

export interface ImportOptions {
  mode?: "append" | "replace";
}

function nowIso() {
  return new Date().toISOString();
}

export class LeqStore {
  readonly db: DatabaseSync;

  constructor(dbPath = "data/leq.sqlite") {
    const fullPath = resolve(dbPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    this.db = new DatabaseSync(fullPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS datasets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        current_version INTEGER NOT NULL DEFAULT 0,
        unit TEXT NOT NULL CHECK(unit='dB'),
        rules_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS segments (
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK(version >= 1),
        segment_id TEXT NOT NULL,
        original_index INTEGER NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL CHECK(end_ms > start_ms),
        leq_db REAL NOT NULL,
        PRIMARY KEY(dataset_id, version, segment_id)
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        window_start_ms INTEGER NOT NULL,
        window_end_ms INTEGER NOT NULL CHECK(window_end_ms > window_start_ms),
        status TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_segments_dataset_version_time
        ON segments(dataset_id, version, start_ms, end_ms);
      CREATE INDEX IF NOT EXISTS idx_reports_dataset ON reports(dataset_id, version);
    `);
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  parseRules(dataset: DatasetRecord): DatasetRules {
    return JSON.parse(dataset.rules_json) as DatasetRules;
  }

  getDatasetOrThrow(datasetId: string): DatasetRecord {
    const row = this.db.prepare("SELECT * FROM datasets WHERE id=?").get(datasetId) as
      | DatasetRecord
      | undefined;
    if (!row) throw new AppError("DATASET_NOT_FOUND", `测点数据集 ${datasetId} 不存在。`, 404);
    return row;
  }

  createDataset(options: CreateDatasetOptions): DatasetRecord {
    const id = options.id?.trim() || `dataset-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
      throw new AppError("INVALID_DATASET_ID", "数据集 id 只能包含字母、数字、下划线和连字符，长度 1-80。");
    }
    const name = options.name?.trim();
    if (!name) throw new AppError("INVALID_NAME", "数据集名称不能为空。");
    const rules: DatasetRules = {
      minDb: options.rules?.minDb ?? DEFAULT_MIN_DB,
      maxDb: options.rules?.maxDb ?? DEFAULT_MAX_DB,
      maxSegmentsPerVersion: options.rules?.maxSegmentsPerVersion ?? DEFAULT_MAX_SEGMENTS_PER_VERSION,
      maxQuerySpanMs: options.rules?.maxQuerySpanMs ?? DEFAULT_MAX_QUERY_SPAN_MS,
    };
    if (!Number.isFinite(rules.minDb) || !Number.isFinite(rules.maxDb) || rules.minDb >= rules.maxDb) {
      throw new AppError("INVALID_RULES", "声级范围必须为有限数且 minDb < maxDb。");
    }
    if (!Number.isSafeInteger(rules.maxSegmentsPerVersion) || rules.maxSegmentsPerVersion < 1) {
      throw new AppError("INVALID_RULES", "maxSegmentsPerVersion 必须是正安全整数。");
    }
    if (!Number.isSafeInteger(rules.maxQuerySpanMs) || rules.maxQuerySpanMs < 1) {
      throw new AppError("INVALID_RULES", "maxQuerySpanMs 必须是正安全整数。");
    }

    try {
      this.db
        .prepare(
          "INSERT INTO datasets(id,name,current_version,unit,rules_json,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(id, name, 0, "dB", JSON.stringify(rules), nowIso());
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        throw new AppError("DATASET_EXISTS", `数据集 ${id} 已存在。`, 409);
      }
      throw error;
    }
    return this.getDatasetOrThrow(id);
  }

  listDatasets() {
    return this.db.prepare("SELECT * FROM datasets ORDER BY id").all() as unknown as DatasetRecord[];
  }

  getSegments(datasetId: string, version: number): StoredSegment[] {
    const rows = this.db
      .prepare(
        `SELECT segment_id AS segmentId, original_index AS originalIndex,
                start_ms AS start, end_ms AS end, leq_db AS leqDb
         FROM segments WHERE dataset_id=? AND version=?
         ORDER BY start_ms, end_ms, original_index`,
      )
      .all(datasetId, version) as unknown as StoredSegment[];
    return rows;
  }

  resolveVersion(dataset: DatasetRecord, requested?: number) {
    if (requested === undefined) return dataset.current_version;
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > dataset.current_version) {
      throw new AppError("VERSION_NOT_FOUND", "请求版本不存在。", 404, {
        currentVersion: dataset.current_version,
        requested,
      });
    }
    return requested;
  }

  importSegments(datasetId: string, rawSegments: unknown, options: ImportOptions = {}) {
    const mode = options.mode ?? "append";
    if (mode !== "append" && mode !== "replace") {
      throw new AppError("INVALID_IMPORT_MODE", "mode 只能是 append 或 replace。");
    }
    const dataset = this.getDatasetOrThrow(datasetId);
    const rules = this.parseRules(dataset);
    const incoming = normalizeAndValidateSegments(
      rawSegments,
      rules.minDb,
      rules.maxDb,
      rules.maxSegmentsPerVersion,
    );

    return this.transaction(() => {
      const fresh = this.getDatasetOrThrow(datasetId);
      const baseVersion = fresh.current_version;
      const base = mode === "append" && baseVersion > 0 ? this.getSegments(datasetId, baseVersion) : [];
      if (mode === "append" && baseVersion === 0 && incoming.length > rules.maxSegmentsPerVersion) {
        throw new AppError("TOO_MANY_SEGMENTS", "段数超过限制。");
      }
      const combined: StoredSegment[] = [...base, ...incoming];
      const combinedIds = new Set<string>();
      for (const segment of combined) {
        if (combinedIds.has(segment.segmentId)) {
          throw new AppError("DUPLICATE_SEGMENT_ID", "追加后的新版本中段编号必须唯一。", 400, {
            duplicateSegmentId: segment.segmentId,
          });
        }
        combinedIds.add(segment.segmentId);
      }
      if (combined.length > rules.maxSegmentsPerVersion) {
        throw new AppError("TOO_MANY_SEGMENTS", `新版本段总数不能超过 ${rules.maxSegmentsPerVersion}。`, 400, {
          total: combined.length,
          maxSegments: rules.maxSegmentsPerVersion,
        });
      }
      assertNoOverlap(combined, "与已有时间段相比");
      const version = baseVersion + 1;
      const insert = this.db.prepare(
        `INSERT INTO segments(dataset_id,version,segment_id,original_index,start_ms,end_ms,leq_db)
         VALUES(?,?,?,?,?,?,?)`,
      );
      for (const segment of combined) {
        insert.run(
          datasetId,
          version,
          segment.segmentId,
          segment.originalIndex,
          segment.start,
          segment.end,
          segment.leqDb,
        );
      }
      this.db.prepare("UPDATE datasets SET current_version=? WHERE id=?").run(version, datasetId);
      return {
        datasetId,
        version,
        mode,
        segmentCount: combined.length,
        segments: combined,
      };
    });
  }

  query(params: { datasetId: string; start: number; end: number; version?: number }): LeqReport {
    const dataset = this.getDatasetOrThrow(params.datasetId);
    const rules = this.parseRules(dataset);
    const window = validateWindow(params.start, params.end, rules.maxQuerySpanMs);
    const version = this.resolveVersion(dataset, params.version);
    const segments = this.getSegments(params.datasetId, version);
    const report = buildReport({
      datasetId: params.datasetId,
      datasetName: dataset.name,
      version,
      windowStart: window.start,
      windowEnd: window.end,
      segments,
    });
    return this.saveReport(report);
  }

  saveReport(report: LeqReport): LeqReport {
    const createdAt = nowIso();
    const result = this.db
      .prepare(
        `INSERT INTO reports(dataset_id,version,window_start_ms,window_end_ms,status,report_json,created_at)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        report.datasetId,
        report.version,
        report.windowStart,
        report.windowEnd,
        report.status,
        JSON.stringify(report),
        createdAt,
      );
    return { ...report, reportId: Number(result.lastInsertRowid), savedAt: createdAt };
  }

  getReport(reportId: number): LeqReport {
    if (!Number.isSafeInteger(reportId) || reportId < 1) {
      throw new AppError("INVALID_REPORT_ID", "报告 id 必须是正整数。");
    }
    const row = this.db.prepare("SELECT report_json FROM reports WHERE id=?").get(reportId) as
      | { report_json: string }
      | undefined;
    if (!row) throw new AppError("REPORT_NOT_FOUND", "报告不存在。", 404);
    return JSON.parse(row.report_json) as LeqReport;
  }

  listReports(datasetId: string) {
    this.getDatasetOrThrow(datasetId);
    return this.db
      .prepare(
        `SELECT id AS reportId, dataset_id AS datasetId, version,
                window_start_ms AS windowStart, window_end_ms AS windowEnd,
                status, created_at AS createdAt
         FROM reports WHERE dataset_id=? ORDER BY id`,
      )
      .all(datasetId);
  }

  validateDataset(datasetId: string, version?: number) {
    const dataset = this.getDatasetOrThrow(datasetId);
    const resolvedVersion = this.resolveVersion(dataset, version);
    const segments = this.getSegments(datasetId, resolvedVersion);
    assertNoOverlap(segments, "当前版本");
    return {
      datasetId,
      version: resolvedVersion,
      currentVersion: dataset.current_version,
      segmentCount: segments.length,
      ok: true,
    };
  }
}
