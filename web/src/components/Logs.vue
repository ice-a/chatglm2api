<script setup>
import { ref, computed, onMounted } from 'vue'
import { NCard, NGrid, NGi, NScrollbar, NTag, NSelect, NButton } from 'naive-ui'
import { state, loadLogs } from '../store'

const filterOpts = computed(() => [
  { label: '全部账号（合并）', value: '' },
  ...(state.accounts || []).map((a) => ({ label: a.name, value: a.id })),
])

const filteredReq = computed(() => {
  const list = state.logs.requests || []
  if (!state.reqFilter) return list
  return list.filter((r) => r.account_id === state.reqFilter)
})

function fmtTime(ms) {
  if (!ms) return '-'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

function isErr(l) {
  return /失败|错误|error|Error|FAIL|401|403|429|503/i.test(l)
}

onMounted(loadLogs)
</script>

<template>
  <n-grid cols="1 980:2" responsive="screen" :x-gap="16" :y-gap="16">
    <n-gi>
      <n-card title="系统日志">
        <template #header-extra>
          <n-button size="small" quaternary @click="loadLogs">刷新</n-button>
        </template>
        <n-scrollbar style="max-height: 520px">
          <div v-if="(state.logs.sys || []).length">
            <div v-for="(l, i) in state.logs.sys" :key="i" class="ln" :class="isErr(l) ? 'err' : ''">{{ l }}</div>
          </div>
          <div v-else class="empty">暂无系统日志</div>
        </n-scrollbar>
      </n-card>
    </n-gi>

    <n-gi>
      <n-card title="API 请求日志">
        <template #header-extra>
          <n-select v-model:value="state.reqFilter" :options="filterOpts" placeholder="全部账号" style="width: 200px" />
        </template>
        <n-scrollbar style="max-height: 520px">
          <div v-if="filteredReq.length">
            <div v-for="(r, i) in filteredReq" :key="i" class="ln">
              <span class="t">{{ fmtTime(r.time) }}</span>
              <span>{{ r.account || '-' }}</span>
              <n-tag :type="r.status === 'ok' ? 'success' : 'error'" size="small">
                {{ r.status }}{{ r.code ? ' ' + r.code : '' }}
              </n-tag>
              <span class="muted">
                {{ r.model || '' }} {{ r.chars ? '· ' + r.chars + '字' : '' }} {{ r.msg || '' }}
              </span>
            </div>
          </div>
          <div v-else class="empty">暂无请求日志</div>
        </n-scrollbar>
      </n-card>
    </n-gi>
  </n-grid>
</template>
