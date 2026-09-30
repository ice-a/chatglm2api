<script setup>
import { ref, reactive, h, computed } from 'vue'
import {
  NCard,
  NDataTable,
  NButton,
  NTag,
  NSpace,
  NInput,
  NModal,
  NForm,
  NFormItem,
  NScrollbar,
} from 'naive-ui'
import { state, api, message, loadState, addAccount, acctAct, acctToggle, acctDel, acctUsage, checkinAll, refreshAll } from '../store'

const form = reactive({ name: '', token: '', refresh_token: '', device_id: '' })

async function onAdd() {
  if (!form.token.trim()) {
    message.warning('请填写 access_token')
    return
  }
  await addAccount({
    name: form.name.trim(),
    token: form.token.trim(),
    refresh_token: form.refresh_token.trim(),
    device_id: form.device_id.trim(),
  })
  form.name = form.token = form.refresh_token = form.device_id = ''
}

function statusTag(row) {
  if (!row.enabled) return h(NTag, { type: 'default', size: 'small' }, { default: () => '停用' })
  if (row.token_valid) return h(NTag, { type: 'success', size: 'small' }, { default: () => '有效' })
  return h(NTag, { type: 'error', size: 'small' }, { default: () => '过期' })
}

function checkinTag(row) {
  if (!row.stats || !row.stats.last_checkin) return h(NTag, { type: 'warning', size: 'small' }, { default: () => '未签' })
  const today = new Date(row.stats.last_checkin).toDateString() === new Date().toDateString()
  return h(NTag, { type: today ? 'success' : 'warning', size: 'small' }, { default: () => (today ? '今日✓' : '未签') })
}

function actions(row) {
  return h(NSpace, { size: 4 }, {
    default: () => [
      h(NButton, { size: 'tiny', onClick: () => acctAct(row.id, 'test') }, { default: () => '测活' }),
      h(NButton, { size: 'tiny', type: 'success', onClick: () => acctAct(row.id, 'checkin') }, { default: () => '签到' }),
      h(NButton, { size: 'tiny', onClick: () => acctAct(row.id, 'refresh') }, { default: () => '续期' }),
      h(NButton, { size: 'tiny', onClick: () => openUsage(row) }, { default: () => '用量' }),
      h(NButton, { size: 'tiny', onClick: () => acctToggle(row.id) }, { default: () => (row.enabled ? '停用' : '启用') }),
      h(NButton, { size: 'tiny', type: 'error', onClick: () => acctDel(row.id, row.name) }, { default: () => '删除' }),
    ],
  })
}

const columns = [
  {
    title: '账号',
    key: 'name',
    render: (row) =>
      h('div', [
        h('b', row.name),
        h('div', { class: 'muted', style: 'font-size:11px' }, (row.nickname || '') + ' ' + (row.phone || '')),
      ]),
  },
  { title: '状态', key: 'enabled', width: 80, render: (row) => statusTag(row) },
  { title: '积分', key: 'score', width: 80, render: (row) => row.score || '-' },
  { title: '签到', key: 'ck', width: 90, render: (row) => checkinTag(row) },
  {
    title: '请求/失败',
    key: 'req',
    width: 110,
    render: (row) => {
      const r = (row.stats && row.stats.requests) || 0
      const er = (row.stats && row.stats.errors) || 0
      const rate = r + er > 0 ? Math.round((er / (r + er)) * 100) : 0
      return h('span', { class: 'num' }, r + ' / ' + er + (rate > 0 ? ' (' + rate + '%)' : ''))
    },
  },
  {
    title: '续期',
    key: 'refresh',
    width: 80,
    render: (row) =>
      h(NTag, { type: row.has_refresh ? 'success' : 'default', size: 'small' }, { default: () => (row.has_refresh ? '有' : '无') }),
  },
  { title: '操作', key: 'ops', render: (row) => actions(row) },
]

/* 用量弹窗 */
const usageShow = ref(false)
const usageData = ref(null)
async function openUsage(row) {
  usageData.value = await acctUsage(row.id)
  usageShow.value = true
}

/* 手机号登录弹窗 */
const phoneShow = ref(false)
const pl = reactive({ session: null, win: null, poll: null, phone: '', code: '', msg: '', sliderState: '', step3: false })

function cleanup() {
  if (pl.poll) clearInterval(pl.poll)
  if (pl.win) {
    try {
      pl.win.close()
    } catch (_) {}
  }
  pl.poll = null
  pl.win = null
  pl.session = null
}

function openPhone() {
  pl.phone = ''
  pl.code = ''
  pl.msg = ''
  pl.sliderState = ''
  pl.step3 = false
  pl.session = null
  phoneShow.value = true
}

function closePhone() {
  phoneShow.value = false
  cleanup()
}

async function plSendCode() {
  if (!/^1\d{10}$/.test(pl.phone.trim())) {
    pl.msg = '手机号格式不正确（11 位数字）'
    return
  }
  pl.msg = ''
  pl.sliderState = '正在发起人机验证…'
  try {
    const r = await api('/api/login/start', { method: 'POST' })
    pl.session = r.session
    pl.win = window.open(r.captcha_url, 'pl-slider', 'width=420,height=560')
    if (!pl.win) {
      pl.msg = '弹窗被浏览器拦截，请允许本站弹窗后重试'
      pl.sliderState = ''
      pl.session = null
      return
    }
    pl.poll = setInterval(async () => {
      if (!pl.session) {
        clearInterval(pl.poll)
        pl.poll = null
        return
      }
      try {
        const st = await api('/api/login/state?session=' + pl.session)
        if (st.ready) {
          clearInterval(pl.poll)
          pl.poll = null
          pl.sliderState = '✓ 人机验证通过，正在下发短信…'
          if (pl.win) {
            try {
              pl.win.close()
            } catch (_) {}
          }
          pl.win = null
          const r2 = await api('/api/login/send-code', {
            method: 'POST',
            body: JSON.stringify({ session: pl.session, phone: pl.phone.trim() }),
          })
          if (r2.ok) {
            pl.sliderState = '✓ 验证码已发送，请查收短信'
            pl.step3 = true
          } else {
            pl.msg = r2.message || '发送失败'
            pl.sliderState = ''
            pl.session = null
          }
        }
      } catch (_) {
        clearInterval(pl.poll)
        pl.poll = null
      }
    }, 1200)
  } catch (e) {
    pl.msg = '发起失败：' + e.message
    pl.sliderState = ''
  }
}

async function plVerify() {
  if (!pl.code.trim()) {
    pl.msg = '请输入验证码'
    return
  }
  if (!pl.session) {
    pl.msg = '会话已失效，请重新获取验证码'
    return
  }
  try {
    const r = await api('/api/login/verify', {
      method: 'POST',
      body: JSON.stringify({ session: pl.session, phone: pl.phone.trim(), code: pl.code.trim() }),
    })
    if (r.ok) {
      phoneShow.value = false
      cleanup()
      message.success('登录成功：' + ((r.account && (r.account.nickname || r.account.name)) || '账号已入池'))
      await loadStateSafe()
    } else {
      pl.msg = r.message || '登录失败'
      pl.session = null
    }
  } catch (e) {
    pl.msg = '登录失败：' + e.message
  }
}

async function loadStateSafe() {
  await loadState()
}
</script>

<template>
  <div>
    <div class="notice">
      添加账号：登录 <a href="https://chatglm.cn" target="_blank">chatglm.cn</a> → F12 → Application → Local Storage →
      复制 <code>chatglm_token</code>（access_token，JWT）。若有 <code>chatglm_refresh_token</code> 也一并填入可实现自动续期。
      token 仅保存在本机 <code>data/accounts.json</code>，面板只显示掩码。
    </div>

    <n-card title="添加账号">
      <n-space vertical>
        <n-space>
          <n-input v-model:value="form.name" placeholder="备注名" style="width: 200px" />
          <n-input v-model:value="form.token" placeholder="access_token (JWT)" style="flex: 1" />
        </n-space>
        <n-space>
          <n-input v-model:value="form.refresh_token" placeholder="refresh_token（可选，用于自动续期）" style="flex: 1" />
          <n-input v-model:value="form.device_id" placeholder="device_id（可选）" style="width: 220px" />
        </n-space>
        <n-space>
          <n-button type="primary" @click="onAdd">＋ 添加账号</n-button>
          <n-button @click="openPhone">📱 手机号登录（滑块+短信）</n-button>
        </n-space>
      </n-space>
    </n-card>

    <n-card title="账号池" style="margin-top: 16px">
      <template #header-extra>
        <n-space>
          <n-button size="small" type="success" @click="checkinAll">一键批量签到</n-button>
          <n-button size="small" @click="refreshAll">一键续期</n-button>
        </n-space>
      </template>
      <n-data-table
        :columns="columns"
        :data="state.accounts"
        :row-key="(row) => row.id"
        :scroll-x="920"
        size="small"
      />
    </n-card>

    <!-- 手机号登录弹窗 -->
    <n-modal
      v-model:show="phoneShow"
      title="手机号登录"
      :mask-closable="false"
      style="width: 420px"
      @close="closePhone"
    >
      <n-space vertical>
        <p style="color: var(--fg2); font-size: 13px; margin: 0">
          输入手机号 → 点「获取验证码」会弹出官方滑块验证，通过后自动下发短信。
        </p>
        <n-space>
          <n-input v-model:value="pl.phone" maxlength="11" placeholder="13800000000" style="flex: 1" />
          <n-button :disabled="!!pl.poll" @click="plSendCode">获取验证码</n-button>
        </n-space>
        <div style="color: var(--fg2); font-size: 13px; min-height: 18px">{{ pl.sliderState }}</div>
        <div v-if="pl.step3">
          <n-space>
            <n-input v-model:value="pl.code" maxlength="6" placeholder="000000" style="flex: 1" />
            <n-button type="primary" @click="plVerify">登录</n-button>
          </n-space>
        </div>
        <div style="color: var(--err); font-size: 13px; min-height: 18px">{{ pl.msg }}</div>
      </n-space>
    </n-modal>

    <!-- 用量弹窗 -->
    <n-modal v-model:show="usageShow" title="用量 · 积分明细" style="width: 560px">
      <div v-if="usageData">
        <div class="kv"><span>积分余额</span><b>{{ usageData.score || '-' }}</b></div>
        <div class="kv"><span>积分规则</span><span class="muted">{{ usageData.score_rule || '-' }}</span></div>
        <h3 style="margin: 16px 0 8px; color: var(--fg3); font-size: 12px">积分记录</h3>
        <n-scrollbar style="max-height: 340px">
          <div v-if="(usageData.records || []).length">
            <div v-for="(x, i) in usageData.records" :key="i" class="ln">
              <span class="t">{{ x.create_time || x.time || '' }}</span>
              <span>{{ x.title || x.description || x.type || '' }}</span>
              <n-tag :type="Number(x.score || x.change || 0) >= 0 ? 'success' : 'error'" size="small">
                {{ x.score || x.change || '' }}
              </n-tag>
            </div>
          </div>
          <div v-else class="empty">无记录</div>
        </n-scrollbar>
      </div>
    </n-modal>
  </div>
</template>
