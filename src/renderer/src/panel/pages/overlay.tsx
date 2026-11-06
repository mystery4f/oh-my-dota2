import { useEffect, useState } from 'react'
import type { OverlayStatus } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CollapsibleGroup, Group, Panel, Row, StatusPill } from '../components/primitives'
import { selectClass } from '../components/select-class'
import { useSaveFlash, useSettings } from '../use-settings'

const EMPTY_OVERLAY: OverlayStatus = {
  visible: false,
  textMode: 'translated',
  panelOpen: false,
  quickPhrases: [],
  locked: true,
  collapsed: false,
  readAloud: false,
  opacity: 0.45,
  geometry: { x: 0, y: 0, width: 520, height: 260 },
  hint: null,
  hotkeys: {}
}

/** 浮层页：纯视觉与对局归属，都是「点一下立刻见效」的控件，没有保存按钮。 */
export function OverlayPage(): React.ReactElement {
  const { settings, update, loadError } = useSettings()
  const [overlay, setOverlay] = useState<OverlayStatus>(EMPTY_OVERLAY)
  const save = useSaveFlash()

  useEffect(() => {
    void window.api.overlayStatus().then(setOverlay)
    return window.api.onOverlayState(setOverlay)
  }, [])

  const act = (p: Promise<OverlayStatus>): void => {
    void p.then(setOverlay)
  }

  if (settings === null) {
    return (
      <Panel>
        <div className="px-4 py-6 text-sm text-muted-foreground">
          {loadError ? `读取配置失败：${loadError}` : '读取设置中…'}
        </div>
      </Panel>
    )
  }

  return (
    <>
      <Panel>
        <Group label="显示">
          <Row label="窗口" hint="按钮顺序 = 调整浮层的完整动线：先显示，再决定锁定还是收起">
            <Button
              variant={overlay.visible ? 'secondary' : 'default'}
              size="sm"
              onClick={() => act(window.api.overlayToggle())}
            >
              {overlay.visible ? '隐藏' : '显示'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!overlay.visible}
              onClick={() => act(window.api.overlaySetLocked(!overlay.locked))}
              title={`锁定 = 几何冻住且不吃鼠标；解锁后可拖动、拉两侧改宽度（${
                overlay.hotkeys.overlayLock ?? '未绑定'
              }）`}
            >
              {overlay.locked ? '解锁' : '锁定'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!overlay.visible}
              onClick={() => act(window.api.overlayToggleCollapse())}
              title={`收成角落里的小图标，再点一下展开（${
                overlay.hotkeys.overlayCollapse ?? '未绑定'
              }）`}
            >
              {overlay.collapsed ? '展开' : '收起'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!overlay.visible || overlay.locked}
              onClick={() => act(window.api.overlayResetGeometry())}
              title="回到默认位置与尺寸"
            >
              还原
            </Button>
            <StatusPill tone={overlay.visible ? 'ready' : 'idle'}>
              {overlay.visible ? '显示中' : '隐藏'}
            </StatusPill>
          </Row>
        </Group>
        <Group label="外观">
          <Row label="底色深浅" stacked hint="只改每行文字的底色，窗口本身始终透明">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={5}
                max={90}
                value={Math.round(overlay.opacity * 100)}
                onChange={(e) => act(window.api.overlaySetOpacity(Number(e.target.value) / 100))}
                className="h-1 w-48 accent-amber-500"
              />
              <span className="w-10 text-right font-mono text-[13px] tabular-nums">
                {Math.round(overlay.opacity * 100)}%
              </span>
            </div>
          </Row>
          <Row
            label="显示模式"
            htmlFor="v2-textMode"
            hint="只显示译文最省视线；等翻译时先占位原文，到达后就地换掉"
          >
            <select
              id="v2-textMode"
              value={overlay.textMode}
              onChange={(e) => act(window.api.overlaySetText(e.target.value as 'translated' | 'both' | 'original'))}
              className={selectClass}
            >
              <option value="translated">只显示译文</option>
              <option value="both">原文 + 译文</option>
              <option value="original">只显示原文</option>
            </select>
          </Row>
        </Group>
        <Group label="位置">
          <Row label="当前几何" hint="宽×高 @ 左，上（DIP）；直接拖浮层或拉两侧改宽度">
            <span className="font-mono text-[13px] tabular-nums text-muted-foreground">
              {Math.round(overlay.geometry.width)}×{Math.round(overlay.geometry.height)} @{' '}
              {Math.round(overlay.geometry.x)},{Math.round(overlay.geometry.y)}
            </span>
          </Row>
        </Group>
        <Group label="对局">
          <Row label="开机自动捕获" hint="应用启动就开始抓聊天；GSI 报进对局也会自动开">
            <input
              type="checkbox"
              className="h-4 w-4 accent-amber-500"
              checked={settings.autoStartCapture}
              onChange={(e) => void save.wrap(update({ autoStartCapture: e.target.checked }))}
            />
            <StatusPill tone={settings.autoStartCapture ? 'ready' : 'idle'}>
              {settings.autoStartCapture ? '自动' : '手动'}
            </StatusPill>
          </Row>
          <Row
            label="我的昵称"
            htmlFor="v2-nicknames"
            stacked
            hint="只做归属标注（自己的消息打上标记），不因它跳过翻译或朗读"
          >
            <div className="flex items-center gap-3">
              <Input
                id="v2-nicknames"
                className="w-72"
                value={settings.myNicknames.join(', ')}
                onChange={(e) =>
                  update({ myNicknames: e.target.value.split(',').map((p) => p.trim()).filter(Boolean) })
                }
                placeholder="我的游戏昵称，用逗号分隔"
              />
              <StatusPill tone="idle">改动即时生效</StatusPill>
            </div>
          </Row>
        </Group>
      </Panel>

      <CollapsibleGroup id="overlay.notes" label="备注">
        <Row label="锁定与截图" hint="锁定的浮层点击穿透且不出现在截图里：调试「看不见」时先看这里的窗口状态胶囊" />
        <Row label="热键" hint="显示 / 锁定 / 收起都有全局热键，到「热键」页改；本页按钮与热键等效" />
      </CollapsibleGroup>
    </>
  )
}
