import type { MonitorAux, SettlementReading } from './types'

// 沉降监测域示例数据（配套 seed.ts 里 settlement / building 的真实业务值）。
// 今天 = 2026-10-05：按各测点布点日期 + 监测频次排期，到点未测的进待补测。
//
// 读数约定：高程单位 m（累计沉降 mm，下沉取正）；同一点同一日期只保留一条读数。
const base = '2026-10-05T08:00:00'

function reading(
  id: number,
  pointCode: string,
  measureDate: string,
  elevation: number,
  cumulative: number,
  rate: number,
  source: SettlementReading['source'] = '自动取数',
): SettlementReading {
  return { id, pointCode, measureDate, elevation, cumulative, rate, source, createdAt: base }
}

export function buildMonitorSeed(): MonitorAux {
  return {
    readings: [
      // SETT-0001 1次/天：10-04 最后读数，10-05 到点未测 → 待补测
      reading(1, 'SETT-0001', '2026-10-02', 7.1564, 1.6, 0.4),
      reading(2, 'SETT-0001', '2026-10-03', 7.1542, 3.8, 2.2),
      reading(3, 'SETT-0001', '2026-10-04', 7.1526, 5.4, 1.6),
      // SETT-0002 1次/天：10-04 读数累计 26.1mm、速率 3.2mm/d，双越限 → 报警（且今日也到点）
      reading(4, 'SETT-0002', '2026-10-02', 6.8312, 19.8, 5.1),
      reading(5, 'SETT-0002', '2026-10-03', 6.8277, 23.3, 3.5),
      reading(6, 'SETT-0002', '2026-10-04', 6.8249, 26.1, 3.2),
      // SETT-0003 1次/3天：09-29 取数异常后一直未补，下一应测 10-02 已逾期
      reading(7, 'SETT-0003', '2026-09-26', 7.0121, 5.1, 0.6),
      // SETT-0004 1次/2天：10-03 累计 27.4mm 越限（速率未越）→ 报警；10-05 到点
      reading(8, 'SETT-0004', '2026-09-29', 6.5211, 19.7, 4.0),
      reading(9, 'SETT-0004', '2026-10-01', 6.5163, 24.5, 2.4),
      reading(10, 'SETT-0004', '2026-10-03', 6.5134, 27.4, 1.5),
      // SETT-0005 1次/天：10-04 正常读数，10-05 到点未测 → 待补测
      reading(11, 'SETT-0005', '2026-10-03', 7.2044, 2.1, 1.0),
      reading(12, 'SETT-0005', '2026-10-04', 7.2028, 3.7, 1.6),
      // SETT-0006 1次/7天：布点 10-05，首测 10-12，尚未到点 → 正常
      // SETT-0007 1次/2天：10-04 已测，下一应测 10-06，未到点 → 正常
      reading(13, 'SETT-0007', '2026-10-02', 6.9012, 2.4, 0.8),
      reading(14, 'SETT-0007', '2026-10-04', 6.8999, 3.7, 0.7),
    ],
    failures: [
      {
        id: 1,
        pointCode: 'SETT-0003',
        area: 'A区',
        measureDate: '2026-09-29',
        reason: '现场采集终端连续 3 次无响应（网关超时）',
        attempts: 3,
        at: '2026-09-29T18:00:00',
        resolved: false,
      },
    ],
    areaEvents: [],
    cursors: [],
    scenario: { kind: 'normal' },
    seq: 100,
  }
}
