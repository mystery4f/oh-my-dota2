import { net } from 'electron'

let installed = false

/**
 * pi-ai (and the OpenAI SDK under it) calls the global fetch with no way to pass a proxy,
 * so route it through Electron's net module. net.fetch inherits the session proxy that
 * index.ts installs with session.setProxy, which keeps provider traffic on the user's proxy.
 */
export function installProxyAwareFetch(): void {
  if (installed) return
  installed = true
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = input instanceof URL ? input.toString() : input
    return net.fetch(target as Parameters<typeof net.fetch>[0], init as Parameters<typeof net.fetch>[1])
  }) as typeof fetch
}
