import type { LeqReport } from "./acoustics.js";

export function exportJson(report: LeqReport): string {
  return JSON.stringify(report, null, 2);
}

function csvField(value: string | number | null): string {
  if (value === null) return "";
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV 导出：头部注释行写明标签/限制，随后是每个交集贡献一行，
 * 可直接用 overlap_duration_ms 与 level_db 回算总 Leq。
 */
export function exportCsv(report: LeqReport): string {
  const lines: string[] = [];
  lines.push(`# point_id,${csvField(report.pointId)}`);
  lines.push(`# version,${report.version}`);
  lines.push(`# window,${report.windowStartMs},${report.windowEndMs},${report.windowDurationMs}ms`);
  lines.push(
    `# covered_ms,${report.coveredDurationMs},coverage_ratio,${report.coverageRatio},completeness,${report.completeness}`,
  );
  lines.push(`# leq_db,${report.leqDb === null ? "" : report.leqDb}`);
  lines.push(`# label,${csvField(report.label)}`);
  for (const note of report.notes) lines.push(`# note,${csvField(note)}`);
  lines.push(
    [
      "kind",
      "seg_id",
      "start_ms",
      "end_ms",
      "duration_ms",
      "level_db",
      "duration_weight",
      "energy_fraction",
      "scaled_energy",
    ].join(","),
  );
  for (const g of report.gaps) {
    lines.push(
      ["gap", "", g.startMs, g.endMs, g.durationMs, "", "", "", ""].map(csvField).join(","),
    );
  }
  for (const c of report.contributions) {
    lines.push(
      [
        "contribution",
        c.segId,
        c.overlapStartMs,
        c.overlapEndMs,
        c.overlapDurationMs,
        c.levelDb,
        c.durationWeight,
        c.energyFraction,
        c.scaledEnergy,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** 人类可读解释：逐段贡献 + 缺口 + 结论限制。 */
export function explainText(report: LeqReport): string {
  const lines: string[] = [];
  lines.push(`测点 ${report.pointId}（数据版本 v${report.version}）`);
  lines.push(
    `窗口 [${report.windowStartMs}, ${report.windowEndMs})，总时长 ${report.windowDurationMs} ms`,
  );
  lines.push(
    `已测覆盖 ${report.coveredDurationMs} ms（${(report.coverageRatio * 100).toFixed(4)}%），缺口 ${report.gaps.length} 个`,
  );
  if (report.gaps.length > 0) {
    for (const g of report.gaps) {
      lines.push(`  缺口 [${g.startMs}, ${g.endMs})  ${g.durationMs} ms`);
    }
  }
  if (report.leqDb === null) {
    lines.push("已测部分 Leq：无结果（窗口完全无覆盖，不返回 0 dB）");
  } else {
    lines.push(`参考最大声级（缩放用，非新指标）：${report.referenceMaxLevelDb} dB`);
    for (const c of report.contributions) {
      lines.push(
        `  seg ${c.segId}：原区间 [${c.originalStartMs}, ${c.originalEndMs}) ${c.originalDurationMs} ms @ ${c.levelDb} dB；` +
          `交集 [${c.overlapStartMs}, ${c.overlapEndMs}) ${c.overlapDurationMs} ms，` +
          `时长权重 ${c.durationWeight.toFixed(6)}，相对能量贡献 ${(c.energyFraction * 100).toFixed(4)}%`,
      );
    }
    lines.push(`已测部分 Leq = ${report.leqDb.toFixed(4)} dB`);
  }
  lines.push(`结论：${report.label}`);
  lines.push("回算：Leq = refMax + 10*log10(Σ scaled_energy / Σ overlap_duration_ms)");
  for (const note of report.notes) lines.push(`说明：${note}`);
  lines.push(`假设：${report.rules.intraSegmentAssumption}`);
  return lines.join("\n");
}
