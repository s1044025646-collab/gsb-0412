# 等效声级分段能量汇总与缺测时长解释后端（Leq Segment Service）

离线、本地运行的后端服务（仅 API 与 CLI，无前端、无 Docker/WSL、无外部在线服务）。
输入同一测点若干**互不重叠**的时间段及每段等效声级 dB，按**段内声能均匀分布**假设，
计算任意查询窗口内**已测部分**的等效连续声级 Leq，并给出覆盖时长、缺口清单与逐段能量贡献解释。

技术栈：TypeScript + Node.js（内置实验模块 `node:sqlite`，零运行时第三方依赖）+ SQLite（WAL）。
运行环境：Node.js `>= 22.5.0`（Windows 本地 PowerShell 直接运行）。

## 核心计算规则

- 公式（仅对与查询窗口的交集计时，左闭右开 `[startMs, endMs)`，相邻端点不重复计时）：

  ```
  Leq = 10 * log10( Σ( overlapMs_i × 10^(levelDb_i/10) ) / Σ( overlapMs_i ) )
  ```

- **不**对 dB 做算术平均；**不**把缺测当 0 dB；**不**做任何插补。
- 数值稳定：以批内参考最大声级 `L_ref` 缩放，
  `Leq = L_ref + 10*log10(Σ w_i·10^((L_i−L_ref)/10) / Σ w_i)`。
  这与直接线性能量求和**数学完全等价**，只是防溢出的计算技巧，不构成另一套声学指标。
- 时间一律整数毫秒。声级必须是有限数（拒绝 `NaN`/`Infinity`），公开允许范围 **[−100, 200] dB**；
  负 dB 本身合法（只要在范围内）。
- 查询从段中间开始/结束时，按交集时长比例分摊该段能量——这是**段内均匀假设下的估算**，
  不声称获得了更细采样的真实测量。报告 `rules.intraSegmentAssumption` 中固定保留该声明。

## 报告内容（JSON / CSV / explain 一致）

- `windowDurationMs` 窗口总时长、`coveredDurationMs` 已测覆盖时长、`coverageRatio` 覆盖比例；
- `gaps` 缺口清单（区间 + 时长），恒有 `缺口时长合计 + 覆盖时长 = 窗口时长`（代码内强制校验）；
- `contributions` 每段：原区间、交集区间、交集时长、时长权重、相对能量贡献（合计 100%）、
  缩放能量项，可用每行的 `overlapDurationMs` 与 `levelDb` **直接回算总 Leq**（代码内强制校验）；
- `leqDb` 已测部分 Leq；完全无覆盖时为 `null`，`completeness="empty"`，**绝不返回 0 dB**；
- `completeness`：`complete` / `partial` / `empty`。只有 `complete` 才标注为整个窗口汇总；
  `partial` 时 `label`、CLI 输出与 CSV 头部都保留“仅供已覆盖部分、存在缺测”的限制说明。

## 数据与版本语义

- 不同测点独立计算；同一测点时间段重叠（端点相邻不算重叠）时**整批拒绝**，不取最新、不相加。
- 时间段长度必须为正；一次批量导入在单个 SQLite 事务中原子提交，任何一条坏值/重叠都整体回滚。
- 每次成功导入建立**新版本快照**（`current_version + 1`，旧版本段全部复制保留）。
  追加/修正观测后，可用 `--version N` 复算旧版本；已持久化的历史报告永久保留其当时的数据与结论。
- 段排序可规范化（按起点），但始终保留调用方提供的原始 `segId`（未提供时按批次下标自动编号）。
- 输入段、单位与规则、查询参数、报告 JSON 均落 SQLite（默认 `data/leq.sqlite`），重启后可查。

限制（可在 `src/config.ts` 调整）：单测点最多 100,000 段；单批次最多 10,000 条；
查询窗口最大跨度 1 年（365 天）；HTTP 请求体 5 MB。

## 快速开始（Windows PowerShell）

```powershell
npm install
npm run build      # 编译到 dist/
npm test           # 编译并运行全部 18 个测试
npm run demo       # 内置演示（60/70dB、半段裁剪、含缺口、无覆盖、重叠拒绝）
```

### 启动 HTTP 服务

```powershell
npm start
# 或：node dist/server.js --port 8080
# 默认 --port 0：由操作系统选择空闲端口，启动日志打印实际端口，仅监听 127.0.0.1
```

环境变量：`LEQ_PORT`（端口）、`LEQ_DB_PATH`（默认 `data/leq.sqlite`）、`LEQ_DATA_DIR`。

### CLI

```powershell
node dist/cli.js create-point P1 "一号测点"
node dist/cli.js list-points
node dist/cli.js validate examples/segments.json          # 只校验不写库
node dist/cli.js import P1 examples/segments.json         # 原子导入，建立新版本
node dist/cli.js query P1 0 2000 --persist               # 查询，持久化后返回 queryId
node dist/cli.js query P1 0 4000 --version 1             # 复算指定历史版本
node dist/cli.js explain 1                                # 中文逐段贡献与缺口解释
node dist/cli.js export 1 csv report.csv                  # 导出 CSV（也支持 json）
```

### HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/points` | 创建测点 `{id, name?}` |
| GET | `/api/points` | 测点列表 |
| POST | `/api/points/:pointId/segments/validate` | 仅校验段数组 |
| POST | `/api/points/:pointId/segments` | 原子批量导入（新版本） |
| POST | `/api/points/:pointId/query?persist=1` | 查询窗口 `{startMs,endMs,version?}` |
| GET | `/api/reports/:queryId` | 读取已保存报告（`?format=csv` 导出 CSV） |

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:<port>/api/points -ContentType application/json `
  -Body '{"id":"P1","name":"一号测点"}'
Invoke-RestMethod -Method Post http://127.0.0.1:<port>/api/points/P1/segments `
  -ContentType application/json -InFile examples/segments.json
Invoke-RestMethod -Method Post "http://127.0.0.1:<port>/api/points/P1/query?persist=1" `
  -ContentType application/json -Body '{"startMs":0,"endMs":2000}'
```

## 错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `INVALID_PARAM` | 400 | 参数类型/格式错误（含 NaN、Infinity、非法 JSON） |
| `INVALID_RANGE` | 422 | 时间段非正长度，或声级超出 [−100,200] dB 公开范围 |
| `OVERLAP_CONFLICT` | 409 | 同测点段重叠，或 segId 重复；整批拒绝 |
| `BATCH_REJECTED` | 422 | 批次内其它整体性校验失败（如 segId 重复） |
| `LIMIT_EXCEEDED` | 413 | 批次大小/段数/窗口跨度超限 |
| `NOT_FOUND` | 404 | 测点、版本或报告不存在 |

无覆盖不是错误：HTTP 200 返回 `leqDb:null` + `completeness:"empty"` + 中文原因。
CLI 校验/冲突类错误以退出码 2 结束并打印 `错误 [CODE]: 原因`。

## 演示复现的关键数值

等时长 60 dB 与 70 dB：

```
Leq = 10*log10((1000·10^6 + 1000·10^7)/2000) = 67.4036 dB
```

明显不同于错误的算术平均 65 dB（`npm run demo` 输出该对比，并展示半段裁剪、
含缺口窗口（缺口 + 覆盖恰等于窗口长度）、完全无覆盖返回 `null`、重叠导入被拒绝）。

## 假设与限制

- 段内声能均匀分布：段内时间裁剪是能量按比例分摊的估算，不反映段内真实起伏；
- 全部测点使用相同参考量与单位 dB，不处理单位/参考量换算问题；
- 不连接传感器、不做频率加权（A/C 等）、不做法规符合性判定、不提供听力风险建议；
- 不合成同时存在的多声源（每段代表该测点该时段已测的等效声级）；
- 缺测不插补、不外推；部分覆盖窗口的 Leq 只能代表已测交集部分；
- 时间为整数毫秒，区间左闭右开。

## 项目结构

```
src/acoustics.ts  校验、重叠检测、裁剪与能量汇总（纯函数）
src/db.ts         SQLite 表结构、事务化版本快照、查询/报告持久化
src/service.ts    业务编排（原子导入、版本查询、历史报告）
src/server.ts     HTTP API（空闲端口选择、错误码映射）
src/cli.ts        CLI 命令
src/export.ts     JSON/CSV 导出与中文解释
src/demo.ts       内置演示
test/             node:test 测试（手算能量夹具 + 服务/HTTP 端到端）
examples/         导入示例 JSON
data/             默认 SQLite 数据目录（运行时生成）
```
