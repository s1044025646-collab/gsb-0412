import { test } from "node:test";
import assert from "node:assert/strict";
import {
  linearEnergy,
  summarizeWindow,
  validateSegment,
  findOverlaps,
  type InputSegment,
} from "../src/acoustics.js";
import { AppError } from "../src/errors.js";

const seg = (segId: number, s: number, e: number, level: number): InputSegment => ({
  segId,
  startMs: s,
  endMs: e,
  levelDb: level,
});

test("等时长 60/70 dB 得约 67.4036，明显不同于算术平均 65", () => {
  const report = summarizeWindow(
    "P",
    1,
    [seg(0, 0, 1000, 60), seg(1, 1000, 2000, 70)],
    { startMs: 0, endMs: 2000 },
  );
  assert.ok(report.leqDb !== null);
  assert.ok(Math.abs(report.leqDb - 67.4036) < 1e-3, `got ${report.leqDb}`);
  assert.ok(Math.abs(report.leqDb - 65) > 2);
  assert.equal(report.completeness, "complete");
});

test("独立手算能量夹具：数值、能量贡献与单位换算", () => {
  // 3000 ms @ 60 dB + 7000 ms @ 70 dB
  // E = 3000*10^6 + 7000*10^7 = 3e9 + 7e10 = 7.3e10 (参考量下的相对能量)
  // Leq = 10*log10(7.3e10/10000) = 10*log10(7.3e6)
  const expected = 10 * Math.log10((3000 * linearEnergy(60) + 7000 * linearEnergy(70)) / 10000);
  const report = summarizeWindow(
    "P",
    1,
    [seg(0, 0, 3000, 60), seg(1, 3000, 10000, 70)],
    { startMs: 0, endMs: 10000 },
  );
  assert.ok(Math.abs((report.leqDb ?? NaN) - expected) < 1e-9);
  // 相对能量贡献手算
  const e0 = 3000 * linearEnergy(60);
  const e1 = 7000 * linearEnergy(70);
  assert.ok(Math.abs(report.contributions[0]!.energyFraction - e0 / (e0 + e1)) < 1e-12);
  assert.ok(Math.abs(report.contributions[1]!.energyFraction - e1 / (e0 + e1)) < 1e-12);
  // 贡献之和为 1，时长权重之和为 1
  const sumFrac = report.contributions.reduce((s, c) => s + c.energyFraction, 0);
  const sumWeight = report.contributions.reduce((s, c) => s + c.durationWeight, 0);
  assert.ok(Math.abs(sumFrac - 1) < 1e-12);
  assert.ok(Math.abs(sumWeight - 1) < 1e-12);
  // 用贡献行直接回算总 Leq（不经缩放基准）
  const back =
    10 *
    Math.log10(
      report.contributions.reduce(
        (s, c) => s + c.overlapDurationMs * linearEnergy(c.levelDb),
        0,
      ) / report.coveredDurationMs,
    );
  assert.ok(Math.abs(back - (report.leqDb as number)) < 1e-9);
});

test("同声级拆分与合并不改变结果", () => {
  const merged = summarizeWindow("P", 1, [seg(0, 0, 2000, 63)], {
    startMs: 0,
    endMs: 2000,
  });
  const split = summarizeWindow(
    "P",
    1,
    [seg(5, 0, 700, 63), seg(6, 700, 1300, 63), seg(7, 1300, 2000, 63)],
    { startMs: 0, endMs: 2000 },
  );
  assert.ok(Math.abs((merged.leqDb ?? NaN) - (split.leqDb ?? NaN)) < 1e-12);
  assert.ok(Math.abs((split.leqDb ?? NaN) - 63) < 1e-12);
});

test("输入顺序不改变结果", () => {
  const a = summarizeWindow(
    "P",
    1,
    [seg(0, 0, 1000, 60), seg(1, 1000, 2000, 70), seg(2, 2000, 3000, 65)],
    { startMs: 0, endMs: 3000 },
  );
  const b = summarizeWindow(
    "P",
    1,
    [seg(2, 2000, 3000, 65), seg(0, 0, 1000, 60), seg(1, 1000, 2000, 70)],
    { startMs: 0, endMs: 3000 },
  );
  assert.equal(a.leqDb, b.leqDb);
  assert.deepEqual(
    a.contributions.map((c) => c.segId),
    b.contributions.map((c) => c.segId),
  );
});

test("时长同比缩放不改变 Leq", () => {
  const small = summarizeWindow("P", 1, [seg(0, 0, 100, 55), seg(1, 100, 300, 72)], {
    startMs: 0,
    endMs: 300,
  });
  const big = summarizeWindow(
    "P",
    1,
    [seg(0, 0, 100_000, 55), seg(1, 100_000, 300_000, 72)],
    { startMs: 0, endMs: 300_000 },
  );
  assert.ok(Math.abs((small.leqDb ?? NaN) - (big.leqDb ?? NaN)) < 1e-10);
});

test("完全无覆盖：无结果、无 Leq、不能当零 dB", () => {
  const report = summarizeWindow("P", 1, [seg(0, 0, 1000, 70)], {
    startMs: 5000,
    endMs: 6000,
  });
  assert.equal(report.leqDb, null);
  assert.equal(report.completeness, "empty");
  assert.equal(report.coveredDurationMs, 0);
  assert.equal(report.gaps[0]!.durationMs, 1000);
  assert.match(report.label, /无结果/);
});

test("裁剪半段与含缺口：缺口+覆盖=窗口长度，部分覆盖带限制标签", () => {
  const report = summarizeWindow(
    "P",
    1,
    [seg(0, 0, 1000, 60), seg(1, 3000, 4000, 80)],
    { startMs: 500, endMs: 3500 },
  );
  assert.equal(report.windowDurationMs, 3000);
  assert.equal(report.coveredDurationMs, 500 + 500);
  const gapTotal = report.gaps.reduce((s, g) => s + g.durationMs, 0);
  assert.equal(gapTotal + report.coveredDurationMs, report.windowDurationMs);
  assert.equal(report.completeness, "partial");
  assert.deepEqual(
    report.gaps.map((g) => [g.startMs, g.endMs, g.durationMs]),
    [[1000, 3000, 2000]],
  );
  assert.match(report.label, /已测部分/);
  assert.match(report.label, /缺测/);
});

test("相邻端点不重复计时；重叠检测只在真重叠时报冲突", () => {
  assert.equal(
    findOverlaps([seg(0, 0, 1000, 60), seg(1, 1000, 2000, 70)]).length,
    0,
  );
  assert.equal(
    findOverlaps([seg(0, 0, 1001, 60), seg(1, 1000, 2000, 70)]).length,
    1,
  );
});

test("非法值：NaN/Infinity/零长度/越界声级全部拒绝，负 dB 在范围内允许", () => {
  assert.throws(
    () => validateSegment({ segId: 0, startMs: 0, endMs: 100, levelDb: NaN }, 0),
    (e: unknown) => e instanceof AppError && e.code === "INVALID_PARAM",
  );
  assert.throws(
    () => validateSegment({ segId: 0, startMs: 0, endMs: 100, levelDb: Infinity }, 0),
    AppError,
  );
  assert.throws(
    () => validateSegment({ segId: 0, startMs: 100, endMs: 100, levelDb: 60 }, 0),
    (e: unknown) => e instanceof AppError && e.code === "INVALID_RANGE",
  );
  assert.throws(
    () => validateSegment({ segId: 0, startMs: 0, endMs: 100, levelDb: 500 }, 0),
    (e: unknown) => e instanceof AppError && e.code === "INVALID_RANGE",
  );
  const ok = validateSegment({ segId: 0, startMs: 0, endMs: 100, levelDb: -40 }, 0);
  assert.equal(ok.levelDb, -40);
});

test("缩放技巧不改变声学指标：极大/极小声级仍稳定有限", () => {
  const report = summarizeWindow(
    "P",
    1,
    [seg(0, 0, 1000, -80), seg(1, 1000, 2000, 190)],
    { startMs: 0, endMs: 2000 },
  );
  assert.ok(Number.isFinite(report.leqDb));
  const direct =
    10 *
    Math.log10((linearEnergy(-80) + linearEnergy(190)) / 2);
  assert.ok(Math.abs((report.leqDb as number) - direct) < 1e-9);
});
