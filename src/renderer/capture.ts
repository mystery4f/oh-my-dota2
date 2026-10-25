// Hidden worker page: holds a desktop capture video stream and crops frames on demand.
// 用一个常驻视频流替代每次 desktopCapturer.getSources（后者单次约 900ms）。

const video = document.getElementById('video') as HTMLVideoElement
const canvas = document.getElementById('frame') as HTMLCanvasElement
const ctx = canvas.getContext('2d')

let ready = false

async function attach(sourceId: string): Promise<void> {
  try {
    const constraints = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: 7680,
          maxHeight: 4320,
          // 只在轮询/手动触发时取帧，10fps 足够，同时少给 WGC 制造失败噪声。
          maxFrameRate: 10
        }
      }
    } as unknown as MediaStreamConstraints
    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    video.srcObject = stream
    await video.play()
    if (video.videoWidth === 0) {
      await new Promise<void>((resolve) => {
        video.addEventListener('loadedmetadata', () => resolve(), { once: true })
      })
    }
    ready = true
    window.api.screenStream.reportReady()
  } catch (err) {
    ready = false
    window.api.screenStream.reportFrame(-1, null, err instanceof Error ? err.message : String(err))
  }
}

window.api.screenStream.onInit(({ sourceId }) => {
  void attach(sourceId)
})

window.api.screenStream.reportHello()

window.api.screenStream.onGrab(({ requestId, rect }) => {
  if (!ready || !ctx) {
    window.api.screenStream.reportFrame(requestId, null, 'capture stream is not ready')
    return
  }
  const x = Math.max(0, Math.min(rect.x, Math.max(0, video.videoWidth - 1)))
  const y = Math.max(0, Math.min(rect.y, Math.max(0, video.videoHeight - 1)))
  const width = Math.max(1, Math.min(rect.width, video.videoWidth - x))
  const height = Math.max(1, Math.min(rect.height, video.videoHeight - y))
  try {
    canvas.width = width
    canvas.height = height
    ctx.drawImage(video, x, y, width, height, 0, 0, width, height)
    const url = canvas.toDataURL('image/png')
    window.api.screenStream.reportFrame(requestId, url.slice(url.indexOf(',') + 1))
  } catch (err) {
    window.api.screenStream.reportFrame(requestId, null, err instanceof Error ? err.message : String(err))
  }
})