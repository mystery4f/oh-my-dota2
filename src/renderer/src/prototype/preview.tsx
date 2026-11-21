import { createRoot } from 'react-dom/client'
import '../styles.css'
import { ShellPreview } from './shell/shell-preview'
import { OverlayPreview } from './overlay/overlay-preview'
import { TalkPrototype } from './talk'

/**
 * 原型的独立入口（一次性，选完即删）。不经过面板壳、不改任何产品代码：
 * 预览服务器里直接开 `/src/prototype/preview.html`。
 *
 * `?shell=2` → 整壳重设计（新菜单 / 新配色 / 七段式接线）
 * `?variant=a|b|c|d` → 对讲页的四个方案，可加 `&broken=1`
 */
const search = window.location.search
const root = createRoot(document.getElementById('root') as HTMLElement)

if (new URLSearchParams(search).has('variant')) {
  root.render(
    <div className="min-h-screen bg-background p-6 text-foreground">
      <TalkPrototype />
    </div>
  )
} else if (new URLSearchParams(search).has('overlay')) {
  const tab = new URLSearchParams(search).get('overlay')
  root.render(
    <OverlayPreview
      initialTab={
        tab === 'look' || tab === 'phrases' || tab === 'suggest' || tab === 'history'
          ? tab
          : 'history'
      }
    />
  )
} else {
  root.render(<ShellPreview />)
}
