# 盾构隧道掘进施工管理平台

面向盾构机台账、掘进环次、管片拼装、同步注浆、渣土外运、地表沉降监测与轴线纠偏的一体化盾构隧道施工管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 盾构机台账 | `shield` | 盾构机 | 盾构机编号、盾构机型号、开挖直径 |
| 掘进环次 | `ring` | 掘进环 | 环号、起始里程、掘进速度 |
| 管片拼装 | `segment` | 管片环 | 管片环号、管片型号、拼装点位 |
| 同步注浆 | `grouting` | 注浆记录 | 注浆编号、对应环号、浆液配比 |
| 渣土外运 | `muck` | 渣土运输单 | 运输单号、对应环号、渣土方量 |
| 地表沉降 | `settlement` | 沉降测点 | 测点编号、测点位置、初始高程 |
| 轴线偏差 | `axis` | 轴线测量 | 测量编号、对应环号、设计轴线 |
| 刀具磨损 | `cutter` | 刀具 | 刀具编号、刀盘位置、刀具类型 |
| 管片生产 | `segmentprod` | 管片 | 管片编号、管片型号、生产模具 |
| 浆液拌制 | `mortar` | 浆液批次 | 批次编号、浆液类型、水泥用量 |
| 洞内通风 | `ventilation` | 通风机组 | 机组编号、风筒长度、送风量 |
| 建筑监测 | `building` | 监测对象 | 对象编号、建筑物名称、结构类型 |
| 管线探查 | `utility` | 地下管线 | 管线编号、管线类型、埋设深度 |
| 进度节点 | `progress` | 进度节点 | 节点编号、节点名称、计划完成日 |
| 试验检测 | `testing` | 试验委托 | 委托编号、试样类型、检测项目 |
| 应急演练 | `drill` | 应急演练 | 演练编号、演练科目、演练日期 |
| 班组进场 | `crew` | 施工班组 | 班组编号、班组名称、主要工种 |
| 安全巡检 | `safety` | 巡检记录 | 巡检编号、巡检区域、巡检项目 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `shield-tunnel-construction:entries` 这一项，或调用 `resetModule(模块)`。

## 地表沉降：取数与兜底规则

沉降模块不是普通台账，取数排期、重试、补测、报警都在
`frontend/src/api/settlement-service.ts`（经 `local-service.ts` 统一导出）：

- **排期**：按测点「布点日期 + 监测频次」推算应测日（演示基准日固定为 2026-10-05）。
  到点没有成功读数的测点自动进待补测，补测顺序为应测日从早到晚、同日测点编号升序。
- **取数重试**：单点取数最多重试 3 次；重试期间绝不把上一轮累计沉降顶上来。
  3 次仍失败才在读数台账记一条「取数异常」并写明原因，主台账累计沉降保持上一轮成功值。
- **整区空态**：整片测区一轮一条都取不回来时当场记异常，页面明确交代「没取到」；
  从未发起测量的测区交代「没测量」，不会停在加载中。
- **断点续测**：补测以批次推进，进度（成功/异常清单）持久化；中途中断可从断点继续，
  已测完的测点幂等跳过。同测点同监测日期只有一条读数，重复提交按 upsert 处理，再交不翻倍；
  校验不过或写不进去的数据原样退回表单。
- **报警**：累计沉降或沉降速率越限自动判定报警（阈值 80% 为预警线），结论写回测点并
  自动同步到建筑监测对象清单。**报警测点数两个页面共用 `settlementStats()` 一份口径**，
  均以地表沉降测点记录为准，建筑监测页不另算。
- **权限**：预警阈值、速率报警阈值、初始高程只有本项目「监测负责人」可改；顶栏可切换
  「监测负责人 / 值班管理员」演示。
- **存量测点**：登记测点布点日期必填，按布点日期补进台账与排期。

沉降相关数据除主台账外另存两处（重置 `settlement` 模块会一并清掉）：

- `shield-tunnel-construction:settlement-readings`：监测读数台账（含异常记录）
- `shield-tunnel-construction:settlement-batches`：补测批次断点进度
- `shield-tunnel-construction:role`：当前角色
- `shield-tunnel-construction:schema-version`：台账结构版本（升级后自动重建沉降/建筑台账）

领域逻辑的端到端验证脚本在 `frontend/scripts/verify-settlement.ts`（经 esbuild 转译后由 node 直跑）。
