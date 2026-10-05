import { defineStore } from 'pinia'
import type { MonitorRole } from '@/data/types'

type SessionState = {
  operator: string
  role: MonitorRole
  shiftLabel: string
  scope: string
}

export const useSessionStore = defineStore('session', {
  state: (): SessionState => ({
    operator: '周监测',
    role: '监测负责人',
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    isMonitorLead: (state) => state.role === '监测负责人',
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    // 切换登录身份：预警阈值与初始高程只有「监测负责人」能动。
    setRole(role: MonitorRole, operator?: string) {
      this.role = role
      if (operator) {
        this.operator = operator
      } else {
        this.operator = role === '监测负责人' ? '周监测' : '李值班'
      }
    },
  },
})
