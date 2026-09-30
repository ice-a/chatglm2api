import { reactive } from 'vue'
import { darkTheme, createDiscreteApi } from 'naive-ui'
import { themeOverrides } from './theme'

// 注意：discrete API 的容器挂在 body 上，不在 n-config-provider 内，
// 必须显式传入 darkTheme，否则弹窗/对话框会回退成浅色主题。
const { message, dialog } = createDiscreteApi(['message', 'dialog'], {
  theme: darkTheme,
  themeOverrides,
})

export const state = reactive({
  online: false,
  accounts: [],
  config: {},
  models: [],
  recent: [],
  totals: { requests: 0, errors: 0, checkins_today: 0 },
  base_urls: {},
  logs: { sys: [], requests: [] },
  fullKey: '',
  reqFilter: '',
})

export async function api(path, opts) {
  const r = await fetch(path, Object.assign({ headers: { 'content-type': 'application/json' } }, opts || {}))
  const t = await r.text()
  let j = {}
  try {
    j = t ? JSON.parse(t) : {}
  } catch (_) {
    j = { raw: t }
  }
  if (!r.ok) throw new Error((j.error && j.error.message) || j.message || 'HTTP ' + r.status)
  return j
}

export async function loadState() {
  try {
    const s = await api('/api/state')
    state.online = true
    state.accounts = s.accounts || []
    state.config = s.config || {}
    state.models = s.models || []
    state.recent = s.recent || []
    state.totals = s.totals || { requests: 0, errors: 0, checkins_today: 0 }
    state.base_urls = s.base_urls || {}
    return s
  } catch (e) {
    state.online = false
    message.error('无法连接后端：' + e.message)
    throw e
  }
}

export async function loadLogs() {
  try {
    state.logs = await api('/api/logs')
  } catch (e) {
    message.error('日志加载失败：' + e.message)
  }
}

export async function saveConfig(payload) {
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify(payload) })
    message.success('设置已保存')
    await loadState()
  } catch (e) {
    message.error('保存失败：' + e.message)
  }
}

export async function checkinAll() {
  message.info('批量签到中…')
  try {
    const r = await api('/api/checkin-all', { method: 'POST' })
    const ok = r.results.filter((x) => x.state === 'ok').length
    const al = r.results.filter((x) => x.state === 'already').length
    message.success(`签到完成：成功 ${ok}，已领 ${al}，共 ${r.results.length}`)
    await loadState()
  } catch (e) {
    message.error(e.message)
  }
}

export async function refreshAll() {
  try {
    const r = await api('/api/refresh-all', { method: 'POST' })
    const ok = r.results.filter((x) => x.ok).length
    message.success(`续期完成：成功 ${ok}/${r.results.length}`)
    await loadState()
  } catch (e) {
    message.error(e.message)
  }
}

export async function showKey() {
  try {
    const r = await api('/api/config/api-key')
    state.fullKey = r.api_key
    return r.api_key
  } catch (e) {
    message.error(e.message)
  }
}

export async function copyKey() {
  if (!state.fullKey) await showKey()
  try {
    await navigator.clipboard.writeText(state.fullKey)
    message.success('已复制到剪贴板')
  } catch (_) {
    message.error('复制失败，请手动复制')
  }
}

export async function resetKey() {
  dialog.warning({
    title: '重置 API Key',
    content: '重置后旧密钥立即失效，确定？',
    positiveText: '确定重置',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        const r = await api('/api/config/api-key', { method: 'POST' })
        state.fullKey = r.api_key
        message.success('密钥已重置')
        await loadState()
      } catch (e) {
        message.error(e.message)
      }
    },
  })
}

export async function addAccount(payload) {
  try {
    await api('/api/accounts', { method: 'POST', body: JSON.stringify(payload) })
    message.success('账号已添加')
    await loadState()
  } catch (e) {
    message.error('添加失败：' + e.message)
  }
}

export async function acctAct(id, act) {
  try {
    if (act === 'test') {
      const r = await api('/api/accounts/' + id + '/test', { method: 'POST' })
      message[r.ok ? 'success' : 'error'](
        r.ok ? `测活成功：${r.nickname || ''} 积分 ${r.score || ''}` : '测活失败：' + (r.message || '')
      )
      await loadState()
    } else if (act === 'checkin') {
      const r = await api('/api/accounts/' + id + '/checkin', { method: 'POST' })
      message[r.ok ? 'success' : 'error']('签到：' + r.msg)
      await loadState()
    } else if (act === 'refresh') {
      const r = await api('/api/accounts/' + id + '/refresh', { method: 'POST' })
      message[r.ok ? 'success' : 'error'](r.ok ? '续期成功' : '续期失败：' + (r.reason || ''))
      await loadState()
    }
  } catch (e) {
    message.error('操作失败：' + e.message)
  }
}

export async function acctToggle(id) {
  try {
    await api('/api/accounts/' + id + '/toggle', { method: 'POST' })
    await loadState()
  } catch (e) {
    message.error(e.message)
  }
}

export async function acctDel(id, name) {
  dialog.warning({
    title: '删除账号',
    content: `确定删除账号「${name}」？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await api('/api/accounts/' + id, { method: 'DELETE' })
        message.success('已删除')
        await loadState()
      } catch (e) {
        message.error(e.message)
      }
    },
  })
}

export async function acctUsage(id) {
  return await api('/api/accounts/' + id + '/usage', { method: 'POST' })
}

export { message, dialog }
