/** unknown → 可读消息：全站唯一的错误串化出口，别再手写 instanceof 三元。 */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))
