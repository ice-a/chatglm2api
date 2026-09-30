<script setup>
import { reactive, computed, onMounted } from 'vue'
import { NCard, NGrid, NGi, NForm, NFormItem, NInput, NInputNumber, NSelect, NSwitch, NButton, NSpace } from 'naive-ui'
import { state, saveConfig, showKey, copyKey, resetKey } from '../store'

const f = reactive({ port: 8788, host: '127.0.0.1', model: '', rotation: 'round_robin', failover: 3, assistant: '', checkin: true, checkinTime: '08:05', refresh: true })

const hostOpts = [
  { label: '127.0.0.1（仅本机，推荐）', value: '127.0.0.1' },
  { label: '0.0.0.0（局域网可访问）', value: '0.0.0.0' },
]
const rotOpts = [
  { label: 'round_robin（依次轮询）', value: 'round_robin' },
  { label: 'least_used（最少使用优先）', value: 'least_used' },
  { label: 'failover（固定首选，失败转移）', value: 'failover' },
]
const modelOpts = computed(() => (state.models || []).map((m) => ({ label: m.id, value: m.id })))

onMounted(syncForm)
function syncForm() {
  const c = state.config || {}
  f.port = c.port ?? 8788
  f.host = c.host || '127.0.0.1'
  f.model = c.default_model || (modelOpts.value[0] && modelOpts.value[0].value) || ''
  f.rotation = c.rotation || 'round_robin'
  f.failover = c.max_failover ?? 3
  f.assistant = c.assistant_id || ''
  f.checkin = c.checkin_enabled !== false
  f.checkinTime = c.checkin_time || '08:05'
  f.refresh = c.refresh_enabled !== false
}

function save() {
  saveConfig({
    port: Number(f.port),
    host: f.host,
    default_model: f.model,
    rotation: f.rotation,
    max_failover: Number(f.failover),
    assistant_id: f.assistant,
    checkin_enabled: f.checkin,
    checkin_time: f.checkinTime,
    refresh_enabled: f.refresh,
  })
}

function onShow() {
  showKey()
}
</script>

<template>
  <n-grid cols="1 980:2" responsive="screen" :x-gap="16" :y-gap="16">
    <n-gi>
      <n-card title="服务设置">
        <n-form label-placement="top">
          <n-form-item label="端口（修改后需重启服务）">
            <n-input-number v-model:value="f.port" :min="1" :max="65535" style="width: 100%" />
          </n-form-item>
          <n-form-item label="监听地址">
            <n-select v-model:value="f.host" :options="hostOpts" />
          </n-form-item>
          <n-form-item label="默认模型">
            <n-select v-model:value="f.model" :options="modelOpts" />
          </n-form-item>
          <n-button type="primary" @click="save">保存</n-button>
        </n-form>
      </n-card>
    </n-gi>

    <n-gi>
      <n-card title="账号池策略">
        <n-form label-placement="top">
          <n-form-item label="轮询方式">
            <n-select v-model:value="f.rotation" :options="rotOpts" />
          </n-form-item>
          <n-form-item label="单请求最大换号次数">
            <n-input-number v-model:value="f.failover" :min="1" :max="10" style="width: 100%" />
          </n-form-item>
          <n-form-item label="assistant_id">
            <n-input v-model:value="f.assistant" />
          </n-form-item>
        </n-form>
      </n-card>
    </n-gi>

    <n-gi>
      <n-card title="自动化">
        <n-space vertical :size="14">
          <n-space align="center" :size="10">
            <n-switch v-model:value="f.checkin" />
            <span>启用每日自动签到</span>
          </n-space>
          <n-input v-model:value="f.checkinTime" placeholder="08:05" />
          <n-space align="center" :size="10">
            <n-switch v-model:value="f.refresh" />
            <span>启用自动续期（需 refresh_token）</span>
          </n-space>
          <n-button type="primary" @click="save">保存</n-button>
        </n-space>
      </n-card>
    </n-gi>

    <n-gi>
      <n-card title="API 密钥">
        <n-space vertical>
          <n-input :value="state.fullKey || '点击右侧按钮查看'" readonly />
          <n-space>
            <n-button size="small" @click="onShow">显示</n-button>
            <n-button size="small" @click="copyKey">复制</n-button>
            <n-button size="small" type="error" @click="resetKey">重置</n-button>
          </n-space>
          <p class="sub">此面板无需后台密码，本机打开即用。</p>
        </n-space>
      </n-card>
    </n-gi>
  </n-grid>
</template>
