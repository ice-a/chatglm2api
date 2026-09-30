<script setup>
import { computed } from 'vue'
import { NCard, NGrid, NGi, NStatistic, NTag, NScrollbar } from 'naive-ui'
import { state } from '../store'

const kpis = computed(() => {
  const s = state
  const okAccts = s.accounts.filter((a) => a.enabled && a.token_valid).length
  return [
    { title: '账号总数', value: s.accounts.length, sub: '启用 ' + s.accounts.filter((a) => a.enabled).length + ' 个' },
    {
      title: '有效 token',
      value: okAccts,
      sub: s.accounts.length - okAccts > 0 ? s.accounts.length - okAccts + ' 个异常/过期' : '全部正常',
    },
    { title: '累计请求', value: s.totals.requests, sub: '失败 ' + s.totals.errors + ' 次' },
    {
      title: '今日签到',
      value: s.totals.checkins_today,
      sub: '自动签到 ' + (s.config.checkin_enabled ? s.config.checkin_time : '已关闭'),
    },
  ]
})

const recent = computed(() => state.recent || [])

function statusOf(a) {
  if (!a.enabled) return { type: 'default', text: '停用' }
  if (a.token_valid) return { type: 'success', text: '有效' }
  return { type: 'error', text: '过期' }
}
</script>

<template>
  <n-grid cols="1 640:2 1024:4" responsive="screen" :x-gap="16" :y-gap="16">
    <n-gi v-for="k in kpis" :key="k.title">
      <n-card>
        <n-statistic :label="k.title" :value="k.value" />
        <template #footer>
          <span class="muted" style="font-size: 12px">{{ k.sub }}</span>
        </template>
      </n-card>
    </n-gi>
  </n-grid>

  <n-grid cols="1 980:2" responsive="screen" :x-gap="16" :y-gap="16" style="margin-top: 16px">
    <n-gi>
      <n-card title="最近请求" :segmented="{ content: true }">
        <n-scrollbar style="max-height: 360px">
          <div v-if="recent.length">
            <div v-for="r in recent.slice(0, 12)" :key="r.time" class="kv">
              <span>{{ r.account || '-' }} · {{ r.model || '' }}</span>
              <n-tag :type="r.status === 'ok' ? 'success' : 'error'" size="small">
                {{ r.status === 'ok' ? (r.stream ? '流式' : '完成') : '失败 ' + (r.code || '') }}
              </n-tag>
            </div>
          </div>
          <div v-else class="empty">暂无请求</div>
        </n-scrollbar>
      </n-card>
    </n-gi>

    <n-gi>
      <n-card title="账号状态总览" :segmented="{ content: true }">
        <n-scrollbar style="max-height: 360px">
          <div v-if="state.accounts.length">
            <div v-for="a in state.accounts" :key="a.id" class="kv">
              <span>{{ a.name }} <span v-if="a.phone" class="muted">· {{ a.phone }}</span></span>
              <span>
                <n-tag :type="statusOf(a).type" size="small">{{ statusOf(a).text }}</n-tag>
                <span v-if="a.score" class="muted" style="margin-left: 8px">{{ a.score }} 分</span>
              </span>
            </div>
          </div>
          <div v-else class="empty">还没有账号，去「账号池」添加</div>
        </n-scrollbar>
      </n-card>
    </n-gi>
  </n-grid>
</template>
