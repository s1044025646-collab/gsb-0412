import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LeqService } from "./service.js";
import { explainText } from "./export.js";

function approx(value: number | null): string {
  return value === null ? "无结果" : value.toFixed(4);
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), "leq-demo-"));
  const dbFile = join(dir, "demo.sqlite");
  const svc = new LeqService(dbFile);

  svc.createPoint("P1", "演示测点");

  // 等时长 60 dB 与 70 dB：各 1000 ms，期望约 67.4036 dB，区别于算术平均 65。
  svc.importBatch(
    "P1",
    [
      { segId: 0, startMs: 0, endMs: 1000, levelDb: 60 },
      { segId: 1, startMs: 1000, endMs: 2000, levelDb: 70 },
      { segId: 2, startMs: 3000, endMs: 4000, levelDb: 65 },
    ],
    { autoSegId: true },
  );

  console.log("=== 演示 1：等时长 60 dB + 70 dB，完整窗口 [0,2000) ===");
  const r1 = svc.queryWindow("P1", { startMs: 0, endMs: 2000 }, { persist: true });
  console.log(explainText(r1));
  console.log(`算术平均（错误做法）= 65.0000 dB；能量汇总 = ${approx(r1.leqDb)} dB`);
  console.log(`已保存报告 queryId=${r1.queryId}（重启后仍可 explain/export）\n`);

  console.log("=== 演示 2：从段中间裁剪，窗口 [500,2500) ===");
  const r2 = svc.queryWindow("P1", { startMs: 500, endMs: 2500 }, { persist: true });
  console.log(explainText(r2));
  console.log("（交集按段内声能均匀假设计时，不代表更细采样真实测量）\n");

  console.log("=== 演示 3：含缺口窗口 [0,4000)，[2000,3000) 缺测 ===");
  const r3 = svc.queryWindow("P1", { startMs: 0, endMs: 4000 }, { persist: true });
  console.log(explainText(r3));
  console.log(`已保存报告 queryId=${r3.queryId}\n`);

  console.log("=== 演示 4：完全无覆盖窗口 [10000,11000) ===");
  const r4 = svc.queryWindow("P1", { startMs: 10000, endMs: 11000 });
  console.log(`completeness=${r4.completeness}, leqDb=${r4.leqDb}（不是 0 dB）`);
  console.log(`label=${r4.label}\n`);

  console.log("=== 演示 5：重叠导入被整批拒绝（不隐藏冲突） ===");
  try {
    svc.importBatch("P1", [{ segId: 9, startMs: 1500, endMs: 1600, levelDb: 80 }], {
      autoSegId: true,
    });
  } catch (err) {
    console.log(`${(err as Error).name}: ${(err as Error).message}`);
  }

  console.log(`\n演示数据库（临时）: ${dbFile}`);
}

main();
