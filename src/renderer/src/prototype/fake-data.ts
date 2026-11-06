// PROTOTYPE (throwaway): fake panel state for the redesign variants — no IPC,
// no persistence. Numbers loosely copied from measured baselines in docs/BENCH.md.
// 领域词汇（对讲/直发/朗读/声出）与 GLOSSARY.md 保持一致。

export type Tone = 'ok' | 'warn' | 'off'

export interface Chip {
  label: string
  tone: Tone
}

export interface SectionRow {
  label: string
  hint?: string
  value: string
  tone?: Tone
  control: 'toggle' | 'select' | 'key' | 'slider' | 'text'
  on?: boolean
}

export interface Section {
  id: string
  title: string
  sub: string
  chips: Chip[]
  rows: SectionRow[]
}

export const statusChips: Chip[] = [
  { label: 'GSI 已连接', tone: 'ok' },
  { label: '引擎预热 p50 0.6s', tone: 'ok' },
  { label: 'GV 服务运行中 · 7865', tone: 'ok' },
  { label: '更新 v3.4.1 可用', tone: 'warn' }
]

export const sections: Section[] = [
  {
    id: 'talk',
    title: '对讲',
    sub: '麦进 → 翻译 → 声出',
    chips: [{ label: 'whisper 已加载', tone: 'ok' }],
    rows: [
      { label: '转写引擎', hint: '本地离线转写', value: 'whisper small', control: 'select' },
      { label: '热词', hint: '逗号分隔，≥2 字生效', value: '谜团, 肉山, 梅肯', control: 'text' },
      { label: '声出引擎', hint: '译文送进游戏语音频道', value: 'GV · 谜团/en 音色包', control: 'select' },
      { label: '说话键', hint: '游戏内按住发言的键，游戏自己接管', value: 'V', control: 'key' }
    ]
  },
  {
    id: 'chatout',
    title: '直发',
    sub: '译文打回游戏聊天框',
    chips: [{ label: 'inplace 就绪', tone: 'ok' }],
    rows: [
      { label: '发送模式', value: '直发：读草稿 → 翻译 → 粘贴回车', control: 'select' },
      { label: '失败回退', hint: '直发失败时的动作', value: '原文放回聊天框', control: 'select' },
      { label: '语气', value: '队友口吻 · 简短', control: 'select' }
    ]
  },
  {
    id: 'announce',
    title: '朗读',
    sub: '捡到的聊天文本念出来',
    chips: [{ label: 'edge 在线', tone: 'ok' }],
    rows: [
      { label: '朗读开关', value: '开', control: 'toggle', on: true },
      { label: '合成引擎', value: 'edge · zh-CN-XiaoxiaoNeural', control: 'select' },
      { label: '语速', value: '1.0×', control: 'slider' },
      { label: '读自己的话', value: '关', control: 'toggle', on: false }
    ]
  },
  {
    id: 'overlay',
    title: '浮层与对局',
    sub: '游戏状态接入与浮层窗口',
    chips: [{ label: 'GSI 已连接', tone: 'ok' }],
    rows: [
      { label: '浮层锁定', hint: '锁定即点击穿透', value: '已锁定', control: 'toggle', on: true },
      { label: '聊天来源', value: 'GSI（不碰屏幕）', control: 'select' },
      { label: '浮层透明度', value: '80%', control: 'slider' },
      { label: 'GSI 端口', hint: '单占用', value: '127.0.0.1:32123', control: 'text' }
    ]
  },
  {
    id: 'hotkeys',
    title: '热键',
    sub: '全局热键，可冲突检测',
    chips: [{ label: '1 处冲突', tone: 'warn' }],
    rows: [
      { label: '显示 / 隐藏浮层', value: 'Alt+Shift+O', control: 'key' },
      { label: '锁定 / 解锁浮层', value: 'Alt+Shift+P', control: 'key' },
      { label: '收起 / 展开浮层', value: 'Alt+Shift+B', control: 'key' },
      { label: '发送', hint: '直发读草稿，其余开回复框', value: 'Alt+Shift+T', control: 'key' },
      { label: '语音对讲', hint: '按住说中文，声出英文', value: 'Alt+Shift+V', tone: 'warn', control: 'key' }
    ]
  },
  {
    id: 'engine',
    title: '翻译引擎',
    sub: 'LLM 服务与会话',
    chips: [
      { label: '已预热', tone: 'ok' },
      { label: 'reasoning 关', tone: 'off' }
    ],
    rows: [
      { label: '服务商', value: '智谱 BigModel', control: 'select' },
      { label: '模型', value: 'glm-4-flash', control: 'select' },
      { label: 'API Key', hint: '按服务商归档，不互串', value: '••••••••（已配置）', control: 'text' },
      { label: '推理开关', hint: 'glm-4-flash 接受但忽略', value: '关', control: 'toggle', on: false }
    ]
  }
]
