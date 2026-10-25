// Picker page for the chat capture region (loaded in the transparent overlay window).

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

const selection = document.getElementById('selection') as HTMLDivElement
const MIN_SIZE = 10

let dragging = false
let startX = 0
let startY = 0

function setRect(rect: Rect): void {
  selection.style.left = `${rect.x}px`
  selection.style.top = `${rect.y}px`
  selection.style.width = `${rect.width}px`
  selection.style.height = `${rect.height}px`
}

function normRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1)
  }
}

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  dragging = true
  startX = e.clientX
  startY = e.clientY
  setRect({ x: startX, y: startY, width: 0, height: 0 })
  selection.style.display = 'block'
})

document.addEventListener('mousemove', (e) => {
  if (!dragging) return
  setRect(normRect(startX, startY, e.clientX, e.clientY))
})

document.addEventListener('mouseup', (e) => {
  if (!dragging || e.button !== 0) return
  dragging = false
  const rect = normRect(startX, startY, e.clientX, e.clientY)
  if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
    window.api.cancelRegionSelection()
    return
  }
  // Window-local coordinates; the main process adds the window origin.
  window.api.submitRegionSelection(rect)
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.api.cancelRegionSelection()
})

document.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  window.api.cancelRegionSelection()
})
