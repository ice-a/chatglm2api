<script setup>
import { ref, computed, h, onMounted } from 'vue'
import { NConfigProvider, NMenu, NButton } from 'naive-ui'
import { darkTheme, themeOverrides } from './theme'
import { state, loadState } from './store'
import Overview from './components/Overview.vue'
import Accounts from './components/Accounts.vue'
import Gateway from './components/Gateway.vue'
import Settings from './components/Settings.vue'
import Logs from './components/Logs.vue'

const view = ref('overview')
const titles = { overview: '概览', accounts: '账号池', gateway: 'API 网关', settings: '设置', logs: '日志' }

const menuOptions = computed(() => [
  { label: '概览', key: 'overview', icon: () => h('span', { class: 'mi' }, '▦') },
  { label: '账号池', key: 'accounts', icon: () => h('span', { class: 'mi' }, '👥') },
  { label: 'API 网关', key: 'gateway', icon: () => h('span', { class: 'mi' }, '🔌') },
  { label: '设置', key: 'settings', icon: () => h('span', { class: 'mi' }, '⚙') },
  { label: '日志', key: 'logs', icon: () => h('span', { class: 'mi' }, '📜') },
])

function onMenu(k) {
  view.value = k
}

onMounted(() => {
  loadState()
  setInterval(() => {
    if (!document.hidden) loadState()
  }, 15000)
})
</script>

<template>
  <n-config-provider :theme="darkTheme" :theme-overrides="themeOverrides">
    <div class="app-shell">
      <aside class="side">
        <div class="brand">
          <div class="logo">智</div>
          <div>
            <b>多账号池面板</b>
            <small>OpenAI 兼容网关</small>
          </div>
        </div>
        <div class="menu-wrap">
          <n-menu :value="view" :options="menuOptions" :indent="18" @update:value="onMenu" />
        </div>
        <div class="side-foot">
          本机运行 · 无后台密码<br />
          数据仅存于本地 data/
        </div>
      </aside>

      <div class="main">
        <header class="topbar">
          <h1>{{ titles[view] }}</h1>
          <div class="spacer"></div>
          <span class="stat">
            <i class="dot" :class="state.online ? 'on' : 'off'"></i>
            {{ state.online ? '运行中 · ' + state.accounts.length + ' 账号' : '离线' }}
          </span>
          <n-button quaternary size="small" @click="loadState">刷新</n-button>
        </header>

        <main class="content">
          <Overview v-if="view === 'overview'" />
          <Accounts v-else-if="view === 'accounts'" />
          <Gateway v-else-if="view === 'gateway'" />
          <Settings v-else-if="view === 'settings'" />
          <Logs v-else-if="view === 'logs'" />
        </main>
      </div>
    </div>
  </n-config-provider>
</template>
