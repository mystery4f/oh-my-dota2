import * as React from 'react'
import { readBroken, readVariant } from './mock'
import { PrototypeSwitcher } from './switcher'
import { VariantA } from './variant-a'
import { VariantB } from './variant-b'
import { VariantC } from './variant-c'
import { VariantD } from './variant-d'

/**
 * 对讲页的三方案原型（一次性代码，选完即删）。
 *
 * 打开方式：`npm run panel:preview` 后访问
 * `/ ?s=talk&variant=a`（或 b / c），加 `&broken=1` 看断链状态。
 * 底部悬浮条 ← / → 换方案，右侧切换「看断链」。
 */
export function TalkPrototype(): React.ReactElement {
  const search = window.location.search
  const variant = readVariant(search)
  const broken = readBroken(search)

  return (
    <div className="pb-12">
      {variant === 'A' ? <VariantA broken={broken} /> : null}
      {variant === 'B' ? <VariantB broken={broken} /> : null}
      {variant === 'C' ? <VariantC broken={broken} /> : null}
      {variant === 'D' ? <VariantD broken={broken} /> : null}
      <PrototypeSwitcher variant={variant} broken={broken} />
    </div>
  )
}
