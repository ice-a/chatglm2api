<script setup>
import { computed } from 'vue'
import { NCard, NGrid, NGi, NDescriptions, NDescriptionsItem, NTag, NInput, NButton, NSpace } from 'naive-ui'
import { state, showKey, copyKey, resetKey } from '../store'

const modelsText = computed(() => (state.models || []).map((m) => m.id).join(' / '))
const firstModel = computed(() => ((state.models && state.models[0] && state.models[0].id) || 'glm-5.3-flash'))

const example = computed(() => {
  const base = (state.base_urls && state.base_urls.gateway) || 'http://127.0.0.1:8788/v1'
  return `curl ${base}/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <你的API_KEY>" \\
  -d '{"model":"${firstModel.value}","messages":[{"role":"user","content":"你好"}],"stream":false}'`
})

function onShow() {
  showKey()
}
</script>

<template>
  <n-grid cols="1 980:2" responsive="screen" :x-gap="16" :y-gap="16">
    <n-gi>
      <n-card title="网关地址（OpenAI 兼容）">
        <n-descriptions :column="1" bordered size="small" label-placement="left">
          <n-descriptions-item label="Base URL">{{ state.base_urls.gateway }}</n-descriptions-item>
          <n-descriptions-item label="模型">{{ modelsText }}</n-descriptions-item>
          <n-descriptions-item label="鉴权">
            <n-tag :type="state.config.has_api_key ? 'success' : 'warning'">
              {{ state.config.has_api_key ? 'Bearer 鉴权' : '未鉴权' }}
            </n-tag>
          </n-descriptions-item>
        </n-descriptions>
        <p class="sub">任何支持 OpenAI 协议的客户端（Cherry Studio / NextChat / LobeChat / OpenAI SDK）填上面 Base URL 即可。</p>
      </n-card>
    </n-gi>

    <n-gi>
      <n-card title="API Key">
        <n-space vertical>
          <n-input :value="state.fullKey || '点击右侧按钮查看'" readonly />
          <n-space>
            <n-button size="small" @click="onShow">显示</n-button>
            <n-button size="small" @click="copyKey">复制</n-button>
            <n-button size="small" type="error" @click="resetKey">重置</n-button>
          </n-space>
        </n-space>
        <p class="sub">密钥为空时网关不鉴权（本机使用足够）。对外暴露建议先重置为自己的密钥。</p>
      </n-card>
    </n-gi>
  </n-grid>

  <n-card title="调用示例" style="margin-top: 16px">
    <pre class="code">{{ example }}</pre>
  </n-card>
</template>
