import { useEffect, useRef } from 'react'

interface Star {
  x: number
  y: number
  r: number
  opacity: number
  speed: number
}

interface ForkNode {
  x: number
  y: number
  r: number
}

const STAR_COUNT = 80
const ACCENT = '#8c72b8'

export function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animId: number
    let stars: Star[] = []
    let forkNodes: ForkNode[] = []
    let time = 0

    function resize() {
      const dpr = window.devicePixelRatio || 1
      canvas!.width = canvas!.offsetWidth * dpr
      canvas!.height = canvas!.offsetHeight * dpr
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      initStars()
      initFork()
    }

    function initStars() {
      const w = canvas!.offsetWidth
      const h = canvas!.offsetHeight
      stars = Array.from({ length: STAR_COUNT }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.2 + 0.3,
        opacity: Math.random() * 0.4 + 0.1,
        speed: Math.random() * 0.3 + 0.1,
      }))
    }

    function initFork() {
      const w = canvas!.offsetWidth
      const h = canvas!.offsetHeight
      const cx = w * 0.55
      const cy = h * 0.45
      forkNodes = [
        { x: cx, y: cy - h * 0.15, r: 4 },
        { x: cx - w * 0.04, y: cy, r: 5 },
        { x: cx + w * 0.05, y: cy - h * 0.02, r: 4.5 },
        { x: cx - w * 0.02, y: cy + h * 0.12, r: 4 },
        { x: cx + w * 0.07, y: cy + h * 0.1, r: 3.5 },
      ]
    }

    function draw() {
      time += 0.008
      const w = canvas!.offsetWidth
      const h = canvas!.offsetHeight
      ctx!.clearRect(0, 0, w, h)

      for (const s of stars) {
        const flicker = Math.sin(time * s.speed * 3 + s.x) * 0.15
        ctx!.globalAlpha = Math.max(0.05, s.opacity + flicker)
        ctx!.fillStyle = '#d4d4d8'
        ctx!.beginPath()
        ctx!.arc(s.x, s.y, s.r, 0, Math.PI * 2)
        ctx!.fill()
      }

      ctx!.globalAlpha = 1

      const breathe = Math.sin(time * 0.8) * 0.15 + 0.85

      ctx!.strokeStyle = ACCENT
      ctx!.lineWidth = 2
      ctx!.globalAlpha = 0.5 * breathe
      ctx!.beginPath()
      for (let i = 0; i < forkNodes.length - 1; i++) {
        const a = forkNodes[i]
        const b = forkNodes[i + 1]
        if (i === 0) ctx!.moveTo(a.x, a.y)
        const cpx = (a.x + b.x) / 2
        const cpy = (a.y + b.y) / 2 - 8
        ctx!.quadraticCurveTo(cpx, cpy, b.x, b.y)
      }
      ctx!.stroke()

      // fork branch
      if (forkNodes.length >= 3) {
        ctx!.beginPath()
        const branch = forkNodes[2]
        const end = forkNodes[4]
        ctx!.moveTo(branch.x, branch.y)
        ctx!.quadraticCurveTo(
          branch.x + (end.x - branch.x) * 0.5,
          branch.y + 10,
          end.x,
          end.y
        )
        ctx!.stroke()
      }

      for (const n of forkNodes) {
        ctx!.globalAlpha = 0.7 * breathe
        ctx!.fillStyle = ACCENT
        ctx!.beginPath()
        ctx!.arc(n.x, n.y, n.r * breathe, 0, Math.PI * 2)
        ctx!.fill()

        ctx!.globalAlpha = 0.15 * breathe
        ctx!.beginPath()
        ctx!.arc(n.x, n.y, n.r * 2.5 * breathe, 0, Math.PI * 2)
        ctx!.fill()
      }

      ctx!.globalAlpha = 1
      animId = requestAnimationFrame(draw)
    }

    resize()
    draw()
    window.addEventListener('resize', resize)

    return () => {
      cancelAnimationFrame(animId)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    />
  )
}
