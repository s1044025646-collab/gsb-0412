import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { LeqService } from "../src/service.js";
import { resetMigrationFlag } from "../src/db.js";
import { AppError } from "../src/errors.js";

let svc: LeqService;

beforeEach(() => {
  resetMigrationFlag();
  svc = new LeqService(":memory:");
  svc.createPoint("P1");
});

test("批次含一条坏值时不发生部分写入", () => {
  assert.throws(
    () =>
      svc.importBatch(
        "P1",
        [
          { segId: 0, startMs: 0, endMs: 1000, levelDb: 60 },
          { segId: 1, startMs: 2000, endMs: 1000, levelDb: 60 },
        ],
        { autoSegId: true },
      ),
    AppError,
  );
  const points = svc.listPoints();
  assert.equal(points[0]!.current_version, 0);
  const report = svc.queryWindow("P1", { startMs: 0, endMs: 10000 });
  assert.equal(report.leqDb, null);
  assert.equal(report.coveredDurationMs, 0);
});

test("批次含一条重叠时整批拒绝（不取最新/不相加）", () => {
  svc.importBatch("P1", [{ segId: 0, startMs: 0, endMs: 1000, levelDb: 60 }], {
    autoSegId: true,
  });
  assert.throws(
    () =>
      svc.importBatch(
        "P1",
        [
          { segId: 1, startMs: 5000, endMs: 6000, levelDb: 70 },
          { segId: 2, startMs: 900, endMs: 1200, levelDb: 80 },
        ],
        { autoSegId: true },
      ),
    (e: unknown) => e instanceof AppError && e.code === "OVERLAP_CONFLICT",
  );
  const points = svc.listPoints();
  assert.equal(points[0]!.current_version, 1);
});

test("追加导入建立新版本；旧版本窗口结果与历史报告保持原数据", () => {
  svc.importBatch("P1", [{ segId: 0, startMs: 0, endMs: 1000, levelDb: 60 }], {
    autoSegId: true,
  });
  const oldReport = svc.queryWindow("P1", { startMs: 0, endMs: 2000 }, { persist: true });
  assert.ok(oldReport.queryId);
  assert.equal(oldReport.completeness, "partial");

  svc.importBatch("P1", [{ segId: 1, startMs: 1000, endMs: 2000, levelDb: 60 }], {
    autoSegId: true,
  });
  const v2 = svc.queryWindow("P1", { startMs: 0, endMs: 2000 });
  assert.equal(v2.version, 2);
  assert.equal(v2.completeness, "complete");
  const v1 = svc.queryWindow("P1", { startMs: 0, endMs: 2000 }, { version: 1 });
  assert.equal(v1.completeness, "partial");
  const stored = svc.getReport(oldReport.queryId);
  assert.equal(stored.version, 1);
  assert.equal(stored.report.completeness, "partial");
  assert.equal(stored.report.coveredDurationMs, 1000);
});

test("查询跨度限制返回 LIMIT_EXCEEDED", () => {
  assert.throws(
    () => svc.queryWindow("P1", { startMs: 0, endMs: 400 * 24 * 3600 * 1000 }),
    (e: unknown) => e instanceof AppError && e.code === "LIMIT_EXCEEDED",
  );
});

test("查询持久化与报告读取往返一致", () => {
  svc.importBatch(
    "P1",
    [
      { segId: 0, startMs: 0, endMs: 1000, levelDb: 60 },
      { segId: 1, startMs: 1000, endMs: 2000, levelDb: 70 },
    ],
    { autoSegId: true },
  );
  const report = svc.queryWindow("P1", { startMs: 0, endMs: 2000 }, { persist: true });
  const stored = svc.getReport(report.queryId);
  assert.equal(stored.report.leqDb, report.leqDb);
  assert.equal(stored.report.contributions.length, 2);
  assert.throws(
    () => svc.getReport(99999),
    (e: unknown) => e instanceof AppError && e.code === "NOT_FOUND",
  );
});

test("不同测点独立计算", () => {
  svc.createPoint("P2");
  svc.importBatch("P1", [{ segId: 0, startMs: 0, endMs: 1000, levelDb: 60 }], {
    autoSegId: true,
  });
  svc.importBatch("P2", [{ segId: 0, startMs: 0, endMs: 1000, levelDb: 90 }], {
    autoSegId: true,
  });
  const a = svc.queryWindow("P1", { startMs: 0, endMs: 1000 });
  const b = svc.queryWindow("P2", { startMs: 0, endMs: 1000 });
  assert.ok(Math.abs((a.leqDb as number) - 60) < 1e-9);
  assert.ok(Math.abs((b.leqDb as number) - 90) < 1e-9);
});

test("规范化排序但保留原始 segId", () => {
  const result = svc.validateIntervals([
    { segId: 42, startMs: 2000, endMs: 3000, levelDb: 65 },
    { segId: 7, startMs: 0, endMs: 1000, levelDb: 60 },
    { segId: 9, startMs: 1000, endMs: 2000, levelDb: 70 },
  ]);
  assert.deepEqual(
    result.normalized.map((s) => s.segId),
    [7, 9, 42],
  );
});
