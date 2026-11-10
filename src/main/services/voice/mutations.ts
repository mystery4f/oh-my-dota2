/**
 * 语音域的「我变了」广播：装引擎、装/删/选音色包、选参考、起服务这些动作在自己的
 * 变更点喊一嗓子，voice-out-readiness 订阅后当场重算就绪行——handler 表不用再各自
 * 记得包一层刷新。单独放一个零依赖的小模块，是因为就绪模块已经依赖 server/voicepack，
 * 域模块反向 import 就绪会成环（与推理互斥开关的注册式做法同一道理）。
 */
export type VoiceOutMutationListener = () => void

const listeners = new Set<VoiceOutMutationListener>()

/** 订阅域变更；返回退订。 */
export function onVoiceOutMutation(listener: VoiceOutMutationListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 域模块在自己的变更完成点调用；没有订阅者时是空操作（探针、纯缝场景）。 */
export function notifyVoiceOutMutation(): void {
  for (const listener of listeners) listener()
}
