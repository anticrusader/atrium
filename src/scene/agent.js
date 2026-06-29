// agent.js
// Visual avatar for a single agent. A small capsule body + colored head that
// walks between zones, bobs while moving, and shows a state indicator above it
// (thinking = pulsing dot, messaging = chat bubble glyph, working = ring).
//
// The avatar mirrors the gateway agent record. The renderer calls:
//   avatar.syncTo(record, zones)   // when the gateway state changes
//   avatar.update(dt, time)        // every frame

import * as THREE from 'three'

const STATUS_COLOR = {
  idle: 0x6b7d99,
  walking: 0x5ab8ff,
  thinking: 0x2fe6d6,
  messaging: 0xffcf5c,
  working: 0x57e08a,
  paused: 0xff6b7a,
}

// Stable per-agent body tint so the same agent looks consistent.
function tintFor(id) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  const hue = (h % 360) / 360
  const c = new THREE.Color()
  c.setHSL(hue, 0.5, 0.6)
  return c
}

export class AgentAvatar {
  constructor(record) {
    this.id = record.id
    this.record = record
    this.group = new THREE.Group()

    const tint = tintFor(record.id)

    // Body (rounded capsule)
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.28, 0.5, 4, 12),
      new THREE.MeshStandardMaterial({ color: tint, roughness: 0.6, metalness: 0.1 })
    )
    body.position.y = 0.7
    body.castShadow = true
    this.body = body

    // Head
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 16, 16),
      new THREE.MeshStandardMaterial({ color: 0xeef4ff, roughness: 0.5 })
    )
    head.position.y = 1.25
    this.head = head

    // State indicator (small glowing orb above the head)
    this.indicator = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 12, 12),
      new THREE.MeshStandardMaterial({
        color: STATUS_COLOR.idle,
        emissive: STATUS_COLOR.idle,
        emissiveIntensity: 1.4,
      })
    )
    this.indicator.position.y = 1.75

    // A soft pad glow under the agent that matches its status.
    this.glow = new THREE.Mesh(
      new THREE.CircleGeometry(0.5, 24),
      new THREE.MeshBasicMaterial({
        color: STATUS_COLOR.idle,
        transparent: true,
        opacity: 0.22,
      })
    )
    this.glow.rotation.x = -Math.PI / 2
    this.glow.position.y = 0.06

    // Selection ring (hidden until this agent is clicked).
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.72, 28),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
    )
    this.ring.rotation.x = -Math.PI / 2
    this.ring.position.y = 0.08
    this.ring.visible = false

    this.group.add(this.glow, this.ring, body, head, this.indicator)

    // Movement state
    this.pos = new THREE.Vector3()
    this.target = new THREE.Vector3()
    this.speed = 2.6 + Math.random() * 1.2
    this.phase = Math.random() * Math.PI * 2
    this.status = record.status
    this.zone = record.zone
    this._needsTarget = true
    this.selected = false
  }

  setSelected(on) {
    this.selected = on
    this.ring.visible = on
  }

  // Pick a random point inside a zone's footprint.
  _pointInZone(zones, key) {
    const z = zones[key] || zones.lounge
    const hx = z.half ? z.half.x : z.radius
    const hz = z.half ? z.half.z : z.radius
    return new THREE.Vector3(
      z.center.x + (Math.random() * 2 - 1) * hx,
      0,
      z.center.z + (Math.random() * 2 - 1) * hz
    )
  }

  // Place instantly (used on first spawn).
  placeIn(zones, key) {
    const p = this._pointInZone(zones, key)
    this.pos.copy(p)
    this.target.copy(p)
    this.group.position.copy(p)
    this.zone = key
    this._needsTarget = false
  }

  // React to a new gateway record.
  syncTo(record, zones) {
    this.record = record
    this.status = record.status
    if (record.zone !== this.zone) {
      this.zone = record.zone
      this.target.copy(this._pointInZone(zones, record.zone))
    }
    const col = STATUS_COLOR[record.status] ?? STATUS_COLOR.idle
    this.indicator.material.color.setHex(col)
    this.indicator.material.emissive.setHex(col)
    this.glow.material.color.setHex(col)
  }

  update(dt, time) {
    // Walk toward target.
    const toTarget = this.target.clone().sub(this.pos)
    const dist = toTarget.length()
    const moving = dist > 0.15

    if (moving) {
      toTarget.normalize()
      const step = Math.min(this.speed * dt, dist)
      this.pos.addScaledVector(toTarget, step)
      // face direction of travel
      this.group.rotation.y = Math.atan2(toTarget.x, toTarget.z)
      // walking bob
      this.phase += dt * 10
      this.body.position.y = 0.7 + Math.abs(Math.sin(this.phase)) * 0.08
    } else {
      // settle
      this.body.position.y += (0.7 - this.body.position.y) * 0.1
    }

    this.group.position.copy(this.pos)

    // Indicator animation by status.
    const t = time + this.phase
    switch (this.status) {
      case 'thinking':
        this.indicator.scale.setScalar(1 + Math.sin(t * 4) * 0.35)
        this.indicator.position.y = 1.75 + Math.sin(t * 2) * 0.05
        break
      case 'messaging':
        this.indicator.position.y = 1.75 + Math.abs(Math.sin(t * 6)) * 0.18
        this.indicator.scale.setScalar(1)
        break
      case 'working':
        this.indicator.rotation.y = t * 2
        this.indicator.scale.setScalar(1.05)
        break
      case 'walking':
        this.indicator.scale.setScalar(0.8)
        break
      case 'paused':
        this.indicator.scale.setScalar(1)
        this.indicator.position.y = 1.7
        break
      default: // idle
        this.indicator.scale.setScalar(0.7 + Math.sin(t) * 0.08)
        this.indicator.position.y = 1.7
    }

    // Glow breathing
    this.glow.material.opacity = 0.16 + Math.abs(Math.sin(t * 1.5)) * 0.14

    // Selection ring spin
    if (this.selected) this.ring.rotation.z = t * 1.5
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose()
      if (o.material) o.material.dispose()
    })
  }
}
