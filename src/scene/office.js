// office.js
// Builds the static office: floor, zone pads, walls, and simple furniture.
// Each zone has a world-space center + radius so agents know where to walk.
//
// The office is laid out on a 2x5 grid of "rooms" around a central courtyard.
// Geometry is intentionally low-poly (boxes + cylinders) — it reads clearly
// from the isometric camera and keeps the scene cheap to render.

import * as THREE from 'three'

// Palette tuned to match the site: deep navy stage, teal/green accents.
const COL = {
  floor: 0x0b1322,
  grid: 0x16263f,
  wall: 0x12203a,
  desk: 0x23354f,
  accentTeal: 0x2fe6d6,
  accentGreen: 0x57e08a,
  accentBlue: 0x5ab8ff,
  accentAmber: 0xffcf5c,
  wood: 0x3a4a63,
  pad: 0x0e1c30,
}

// Zone layout: world coordinates (x,z) for the center of each zone.
// Tuned so zones don't overlap and the courtyard sits in the middle.
export const ZONE_LAYOUT = {
  reception:  { x: 0,    z: 22,  w: 16, d: 8,  color: COL.accentBlue,  label: 'RECEPTION' },
  lounge:     { x: -22,  z: 12,  w: 14, d: 12, color: COL.accentTeal,  label: 'LOUNGE' },
  designers:  { x: 22,   z: 12,  w: 14, d: 12, color: COL.accentBlue,  label: 'DESIGNERS' },
  library:    { x: -22,  z: -8,  w: 14, d: 12, color: COL.accentAmber, label: 'LIBRARY' },
  cafe:       { x: 22,   z: -8,  w: 14, d: 12, color: COL.accentGreen, label: 'CAFÉ' },
  jira:       { x: -22,  z: -28, w: 14, d: 12, color: COL.accentBlue,  label: 'JIRA FLOOR' },
  office:     { x: 22,   z: -28, w: 14, d: 12, color: COL.accentTeal,  label: 'PRIVATE OFFICE' },
  conference: { x: 0,    z: -36, w: 18, d: 10, color: COL.accentAmber, label: 'CONFERENCE HALL' },
  playroom:   { x: 0,    z: 4,   w: 12, d: 10, color: COL.accentGreen, label: 'PLAY ROOM' },
  courtyard:  { x: 0,    z: -12, w: 14, d: 14, color: COL.accentTeal,  label: 'COURTYARD' },
}

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.85,
    metalness: opts.metalness ?? 0.05,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
  })
}

function box(w, h, d, color, opts) {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, opts))
}

function cyl(rTop, rBot, h, color, opts, seg = 16) {
  return new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat(color, opts))
}

// A glowing canvas-text label that floats above each zone.
function makeLabel(text, color = '#9fb6d6') {
  const canvas = document.createElement('canvas')
  canvas.width = 512; canvas.height = 96
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, 512, 96)
  ctx.font = '600 46px ui-monospace, monospace'
  ctx.fillStyle = color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.shadowColor = color
  ctx.shadowBlur = 18
  ctx.fillText(text, 256, 52)
  const tex = new THREE.CanvasTexture(canvas)
  tex.anisotropy = 4
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }))
  spr.scale.set(10, 1.9, 1)
  return spr
}

// Furniture builders — each returns a THREE.Group placed at origin; caller
// positions it. Kept small and readable; embellish freely.
const furniture = {
  desk(color = COL.desk) {
    const g = new THREE.Group()
    const top = box(2.4, 0.16, 1.2, color, { roughness: 0.6 })
    top.position.y = 0.92
    const legGeo = [[-1, -0.5], [1, -0.5], [-1, 0.5], [1, 0.5]]
    legGeo.forEach(([x, z]) => {
      const l = box(0.12, 0.92, 0.12, 0x1a2840)
      l.position.set(x, 0.46, z)
      g.add(l)
    })
    // a glowing "monitor"
    const mon = box(1.0, 0.6, 0.06, 0x0a0f1a, { emissive: COL.accentBlue, emissiveIntensity: 0.5 })
    mon.position.set(0, 1.4, -0.4)
    g.add(top, mon)
    return g
  },
  chair(color = 0x1c2c45) {
    const g = new THREE.Group()
    const seat = box(0.7, 0.12, 0.7, color)
    seat.position.y = 0.5
    const back = box(0.7, 0.7, 0.12, color)
    back.position.set(0, 0.85, -0.3)
    g.add(seat, back)
    return g
  },
  table(r = 1.4, color = COL.wood) {
    const g = new THREE.Group()
    const top = cyl(r, r, 0.14, color, { roughness: 0.5 })
    top.position.y = 0.9
    const stem = cyl(0.18, 0.22, 0.9, 0x1a2840)
    stem.position.y = 0.45
    g.add(top, stem)
    return g
  },
  shelf(color = COL.wood) {
    const g = new THREE.Group()
    for (let i = 0; i < 4; i++) {
      const s = box(2.2, 0.1, 0.6, color)
      s.position.y = 0.5 + i * 0.7
      g.add(s)
      // colorful "books"
      for (let b = 0; b < 6; b++) {
        const book = box(0.18, 0.5, 0.4,
          [COL.accentTeal, COL.accentGreen, COL.accentAmber, COL.accentBlue][b % 4])
        book.position.set(-0.9 + b * 0.32, 0.8 + i * 0.7, 0)
        g.add(book)
      }
    }
    return g
  },
  poolTable() {
    const g = new THREE.Group()
    const felt = box(3.2, 0.3, 1.7, 0x1f7a4d, { roughness: 0.9 })
    felt.position.y = 0.8
    const rim = box(3.5, 0.16, 2.0, COL.wood)
    rim.position.y = 0.97
    g.add(rim, felt)
    return g
  },
  plant() {
    const g = new THREE.Group()
    const pot = cyl(0.28, 0.34, 0.5, 0x2a3954)
    pot.position.y = 0.25
    const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0), mat(COL.accentGreen, { roughness: 1 }))
    bush.position.y = 0.95
    g.add(pot, bush)
    return g
  },
  board(color = COL.accentAmber) {
    // a Jira-style standup board
    const g = new THREE.Group()
    const panel = box(3.0, 1.8, 0.1, 0x0c1626, { emissive: color, emissiveIntensity: 0.12 })
    panel.position.y = 1.6
    g.add(panel)
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 3; r++) {
        const card = box(0.7, 0.4, 0.04,
          [COL.accentTeal, COL.accentGreen, COL.accentAmber][c])
        card.position.set(-1 + c, 2.1 - r * 0.55, 0.08)
        g.add(card)
      }
    }
    return g
  },
}

// Builds the entire office and returns { group, zones }.
// `zones` maps zone key → { center: Vector3, radius, color }.
export function buildOffice() {
  const group = new THREE.Group()
  const zones = {}

  // --- Ground plane + grid ---
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    mat(COL.floor, { roughness: 1 })
  )
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  group.add(ground)

  const grid = new THREE.GridHelper(120, 60, COL.grid, COL.grid)
  grid.position.y = 0.01
  grid.material.opacity = 0.35
  grid.material.transparent = true
  group.add(grid)

  // --- Build each zone ---
  for (const [key, z] of Object.entries(ZONE_LAYOUT)) {
    const zg = new THREE.Group()
    zg.position.set(z.x, 0, z.z)

    // Zone pad (the "colored spawn pad" look from the site)
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(z.w, 0.08, z.d),
      mat(COL.pad, { emissive: z.color, emissiveIntensity: 0.10, roughness: 0.7 })
    )
    pad.position.y = 0.05
    zg.add(pad)

    // Glowing border ring around the pad
    const border = new THREE.Mesh(
      new THREE.BoxGeometry(z.w + 0.3, 0.1, z.d + 0.3),
      mat(0x000000, { emissive: z.color, emissiveIntensity: 0.6, transparent: true, opacity: 0.25 })
    )
    border.position.y = 0.04
    zg.add(border)

    // Floating label
    const label = makeLabel(z.label, '#' + z.color.toString(16).padStart(6, '0'))
    label.position.set(0, 4.6, 0)
    zg.add(label)

    // Zone-specific furniture
    decorateZone(key, zg, z)

    group.add(zg)
    zones[key] = {
      center: new THREE.Vector3(z.x, 0, z.z),
      half: { x: z.w / 2 - 1.5, z: z.d / 2 - 1.5 },
      radius: Math.min(z.w, z.d) / 2 - 1.5,
      color: z.color,
    }
  }

  // --- Outer walls (low, so the iso camera sees in) ---
  const wallMat = mat(COL.wall, { roughness: 0.9, transparent: true, opacity: 0.5 })
  const bounds = [
    [0, 26, 100, 0.4],   // back-ish
    [0, -42, 100, 0.4],
    [-50, -8, 0.4, 80],
    [50, -8, 0.4, 80],
  ]
  bounds.forEach(([x, z, w, d]) => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 1.2, d), wallMat)
    wall.position.set(x, 0.6, z)
    group.add(wall)
  })

  return { group, zones }
}

function decorateZone(key, zg, z) {
  const place = (obj, x, y, z2, ry = 0) => {
    obj.position.set(x, y ?? 0, z2)
    obj.rotation.y = ry
    zg.add(obj)
  }

  switch (key) {
    case 'reception':
      place(furniture.table(2.0), 0, 0, 0)
      place(furniture.plant(), -6, 0, 0)
      place(furniture.plant(), 6, 0, 0)
      break
    case 'designers':
      for (let i = 0; i < 4; i++) {
        const dx = (i % 2 === 0 ? -3 : 3)
        const dz = (i < 2 ? -3 : 3)
        place(furniture.desk(), dx, 0, dz, i % 2 ? Math.PI : 0)
        place(furniture.chair(), dx, 0, dz + (i % 2 ? -1.2 : 1.2))
      }
      break
    case 'library':
      place(furniture.shelf(), -4, 0, -3)
      place(furniture.shelf(), 0, 0, -3)
      place(furniture.shelf(), 4, 0, -3)
      place(furniture.table(1.2), 0, 0, 3)
      break
    case 'cafe':
      place(furniture.table(1.0), -3, 0, -2)
      place(furniture.table(1.0), 3, 0, -2)
      place(furniture.table(1.0), 0, 0, 3)
      place(furniture.plant(), -5, 0, 4)
      break
    case 'playroom':
      place(furniture.poolTable(), 0, 0, 0)
      break
    case 'jira':
      place(furniture.board(), 0, 0, -4)
      for (let i = 0; i < 3; i++) {
        place(furniture.desk(), -3 + i * 3, 0, 2)
      }
      break
    case 'office':
      place(furniture.desk(), 0, 0, -2)
      place(furniture.chair(), 0, 0, -0.6, Math.PI)
      place(furniture.plant(), 4, 0, 3)
      break
    case 'conference':
      place(furniture.table(2.4), 0, 0, 0)
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2
        place(furniture.chair(), Math.cos(ang) * 3.2, 0, Math.sin(ang) * 2.2, -ang)
      }
      break
    case 'lounge':
      place(furniture.table(1.4), 0, 0, 0)
      place(furniture.plant(), -5, 0, -4)
      place(furniture.plant(), 5, 0, 4)
      break
    case 'courtyard':
      place(furniture.plant(), 0, 0, 0)
      place(furniture.plant(), -4, 0, -4)
      place(furniture.plant(), 4, 0, 4)
      place(furniture.plant(), -4, 0, 4)
      place(furniture.plant(), 4, 0, -4)
      break
  }
}
