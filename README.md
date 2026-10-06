# 离线等效声级分段能量汇总服务

这是一个只包含后端 API 与 CLI 的 Windows 本地项目，用 TypeScript、Node.js 和内置 `node:sqlite` 实现。它根据同一测点互不重叠的时间段及每段等效声级，计算任意窗口内**已测部分**的等效连续声级 Leq。

不连接传感器、不调用在线 API、不需要 Docker 或 WSL，也不做频率加权滤波、法规评价、听力风险建议或多声源合成。

## 计算假设

- 所有测点使用相同参考量，声级单位固定为 `dB`。
- 时间使用整数毫秒，区间统一为左闭右开 `[start,end)`，相邻端点不重复计时。
- 每个输入段内声能视为均匀分布；查询从段中间开始或结束时，只按交集时长做估算，不声称获得更细采样。
- 先把声级换算为线性能量权重，再按时长汇总：

```text
Leq = 10 * log10( sum(durationMs_i * 10^(Leq_i/10)) / measuredDurationMs )
```

- 绝不对 dB 做普通算术平均；缺测时间不当作 0 dB，也不外推。
- 默认公开可接受声级范围为 `[-100, 200] dB`，负 dB 可接受。可在创建数据集时按规则调整。
- 计算使用 `referenceMaxDb` 做指数缩放以改善数值范围，但同时保存未缩放线性权重，报告可回算同一 Leq，不形成另一套指标。

## 限制与持久化规则

- 单个版本默认最多 `10000` 段；查询窗口默认最多 `366` 天。
- 同一数据集、同一版本中时间段重叠会拒绝导入；相邻但不重叠可以声级不同。
- 段时长必须为正毫秒；声级必须是有限数并在公开范围内；查询窗口必须是正长度安全整数。
- 导入在 SQLite 事务中完成：任何一条重叠、坏值或超限制都会整批回滚，不会部分写入。
- 追加或修正观测都会创建新版本；旧报告 JSON 连同版本号和原查询参数保存，仍指向当时数据。
- 数据默认保存到项目内 `data/leq.sqlite`；演示使用 `data/demo.sqlite`。

## 环境要求

- Node.js 25 或支持内置 `node:sqlite` 的 Node 版本。
- npm。
- 当前 Node 版本会输出 SQLite experimental warning，不影响功能。

## 安装与构建

```powershell
npm install
npm run build
```

## 运行测试

```powershell
npm test
```

测试覆盖：

- 等时长 60 dB 与 70 dB 得到约 `67.403627 dB`，不同于算术平均 65。
- 独立手算能量、贡献百分比和回算公式。
- 同声级拆分/合并、输入顺序变化、所有时长同比缩放不改变结果。
- 半段裁剪、含缺口、完全无覆盖。
- 缺口时长加已测时长等于窗口时长。
- 重叠、非正时长、`NaN`、超范围声级拒绝。
- 坏批次事务回滚、SQLite 重启持久化、历史报告版本冻结。

## 一键演示

```powershell
npm run demo
```

演示会重建 `data/demo.sqlite`，依次展示：

1. `[0,2000)` 中 60 dB 和 70 dB 各 1 秒，结果 `67.403627 dB`。
2. 查询 `[500,1500)`，从两段中间各裁剪半秒。
3. 查询 `[1500,3000)`，只有 500 ms 覆盖、1000 ms 缺测。
4. 查询 `[3000,4000)`，完全无覆盖，`measuredPartLeqDb` 为 `null`。

## CLI

创建数据集：

```powershell
node --experimental-sqlite dist/cli/index.js create-dataset --id point-1 --name "一号测点"
```

批量导入。`examples/segments.json` 中包含 `segments` 数组：

```powershell
node --experimental-sqlite dist/cli/index.js import point-1 --file examples/segments.json --mode append
```

`--mode append` 会在当前版本后生成新版本并保留旧段；`--mode replace` 用整批数据生成修正版本，适合修正观测。

校验当前或指定版本：

```powershell
node --experimental-sqlite dist/cli/index.js validate point-1
node --experimental-sqlite dist/cli/index.js validate point-1 --version 1
```

查询窗口：

```powershell
node --experimental-sqlite dist/cli/index.js query point-1 --start 0 --end 2000 --format json
node --experimental-sqlite dist/cli/index.js query point-1 --start 500 --end 3000 --format csv --out report.csv
```

查看历史报告：

```powershell
node --experimental-sqlite dist/cli/index.js list-reports point-1
node --experimental-sqlite dist/cli/index.js report 1 --format json
node --experimental-sqlite dist/cli/index.js report 1 --format csv --out report-1.csv
```

启动 API。不传端口时让操作系统选择空闲端口：

```powershell
node --experimental-sqlite dist/cli/index.js serve
node --experimental-sqlite dist/cli/index.js serve --port 8080
```

可用 `--db <路径>` 或环境变量 `LEQ_DB` 改变 SQLite 文件。

## HTTP API

服务默认绑定 `127.0.0.1`。`PORT=0` 或不传端口时自动选择空闲端口。

### `GET /health`

健康检查。

### `POST /datasets`

```json
{
  "id": "point-1",
  "name": "一号测点",
  "rules": {
    "minDb": -100,
    "maxDb": 200,
    "maxSegmentsPerVersion": 10000,
    "maxQuerySpanMs": 31622400000
  }
}
```

`id` 和 `rules` 可省略。

### `GET /datasets` / `GET /datasets/:id`

列出或查看数据集。

### `POST /datasets/:id/segments`

```json
{
  "mode": "append",
  "segments": [
    { "segmentId": "raw-001", "start": 0, "end": 1000, "leqDb": 60 },
    { "segmentId": "raw-002", "start": 1000, "end": 2000, "leqDb": 70 }
  ]
}
```

`segmentId` 可省略，省略时保留自动编号；显式编号会按字符串保存。排序可以规范化，但每个段都保存 `originalIndex`。

### `POST /datasets/:id/validate`

请求体可为 `{}` 或 `{"version":1}`。

### `POST /query`

```json
{ "datasetId": "point-1", "start": 500, "end": 3000, "version": 1 }
```

`version` 省略时查询当前版本。响应包含：

- 窗口总时长 `windowDurationMs`。
- 已测时长 `measuredDurationMs`。
- 缺口数组 `gaps`。
- 覆盖比例 `coverageRatio` 与百分比 `coveragePercent`。
- 状态 `COMPLETE`、`PARTIAL` 或 `NO_COVERAGE`。
- 已测部分 Leq；无覆盖时为 `null`。
- 每段原区间、交集区间、时长权重、线性能量权重和相对贡献。
- 用贡献回算的 `recomputedLeqDb`。
- 含缺测时的中文限制标签和说明。

### 报告导出

- `GET /reports?datasetId=point-1`：列报告元数据。
- `GET /reports/1?format=json`：读取保存的 JSON 报告。
- `GET /reports/1?format=csv`：导出 CSV。

CSV 含状态和限制标签；`PARTIAL`/`NO_COVERAGE` 不会被标成完整窗口汇总。

## 错误码

- `INVALID_JSON`：请求体不是合法 JSON。
- `INVALID_TIME` / `INVALID_WINDOW`：时间不是安全整数或窗口非正。
- `QUERY_SPAN_TOO_LARGE`：查询跨度超限。
- `INVALID_SEGMENTS` / `EMPTY_BATCH` / `INVALID_SEGMENT`：批次结构错误。
- `NON_POSITIVE_DURATION`：段时长非正。
- `INVALID_DB` / `DB_OUT_OF_RANGE`：声级非有限数或超出公开范围。
- `OVERLAPPING_SEGMENTS`：同测点时间段重叠。
- `DUPLICATE_SEGMENT_ID`：同批次段编号重复。
- `TOO_MANY_SEGMENTS`：段数超限。
- `DATASET_NOT_FOUND` / `DATASET_EXISTS` / `VERSION_NOT_FOUND` / `REPORT_NOT_FOUND`。
- `INVALID_DATASET_ID` / `INVALID_NAME` / `INVALID_RULES` / `INVALID_IMPORT_MODE` / `INVALID_FORMAT`。

错误响应统一为：

```json
{ "error": { "code": "ERROR_CODE", "message": "中文说明", "details": {} } }
```

## 主要源码

- `src/core.ts`：校验、重叠检查、裁剪、缺口和能量汇总。
- `src/db.ts`：SQLite 表结构、事务、版本和报告持久化。
- `src/server.ts`：HTTP API。
- `src/cli/index.ts`：命令行。
- `src/export.ts`：JSON/CSV 导出。
- `src/tests/`：手算夹具和持久化测试。
