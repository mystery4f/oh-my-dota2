/**
 * node:sqlite 在 Electron 37 的 Node 22 上仍是实验特性，首次加载会往 stderr 打
 * `ExperimentalWarning: SQLite is an experimental feature`。这是我们主动选的存储层，
 * 只过滤这一条（其他 ExperimentalWarning 照旧），免得用户以为程序出错了。
 */
export function suppressExperimentalSqliteWarning(): void {
  const original = process.emitWarning.bind(process)
  process.emitWarning = ((
    warning: string | Error,
    ...rest: unknown[]
  ): void => {
    const options = rest.find((item): item is { type?: string } => typeof item === 'object' && item !== null)
    const type = typeof rest[0] === 'string' ? rest[0] : options?.type
    const message = typeof warning === 'string' ? warning : warning.message
    if (type === 'ExperimentalWarning' && /sqlite/i.test(message)) return
    ;(original as (...args: unknown[]) => void)(warning, ...rest)
  }) as typeof process.emitWarning
}