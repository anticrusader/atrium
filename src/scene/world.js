// world.js
// Owns the Three.js renderer, camera, lights, the office, and the live set of
// agent avatars. Exposes a small API the rest of the app drives:
//   world.spawn(records)         // build avatars from a roster snapshot
//   world.sync(records)          // reconcile avatars with new gateway state
//   world.onHover(cb)            // hover callback -> record | null + screen xy
//   world.start()                // begin the render loop

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { buildOffice } from './office.js'
import { AgentAvatar } from './agent.js'

export class World {
  constructor(mountEl) {
    this.mount = mountEl
    this.avatars = new Map() // id -> AgentAvatar
    this._hoverCb = null
    this._clock = new THREE.Clock()

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    mountEl.appendChild(this.renderer.domElement)

    // Scene + fog
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x05070d)
    this.scene.fog = new THREE.Fog(0x05070d, 55, 140)

    // Camera (isometric-ish perspective)
    this.camera = new THREE.PerspectiveCamera(
      42, window.innerWidth / window.innerHeight, 0.1, 500
    )
    this.camera.position.set(46, 48, 58)

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 0, -6)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 24
    this.controls.maxDistance = 140
    this.controls.maxPolarAngle = Math.PI / 2.15
    this.controls.autoRotate = true
    this.controls.autoRotateSpeed = 0.35

    this._setupLights()

    // Office
    const { group, zones } = buildOffice()
    this.zones = zones
    this.scene.add(group)

    // Picking
    this.ray = new THREE.Raycaster()
    this.pointer = new THREE.Vector2()
    this._hovered = null
    this._selectedId = null
    this._selectCb = null
    this.renderer.domElement.addEventListener('pointermove', (e) => this._onPointerMove(e))
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      this.controls.autoRotate = false
      this._downAt = { x: e.clientX, y: e.clientY }
    })
    this.renderer.domElement.addEventListener('pointerup', (e) => this._onPointerUp(e))

    window.addEventListener('resize', () => this._onResize())
  }

  _setupLights() {
    const hemi = new THREE.HemisphereLight(0x9fc6ff, 0x0a1020, 0.55)
    this.scene.add(hemi)

    const key = new THREE.DirectionalLight(0xbfe3ff, 1.1)
    key.position.set(30, 60, 20)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.near = 1
    key.shadow.camera.far = 200
    const s = 70
    key.shadow.camera.left = -s
    key.shadow.camera.right = s
    key.shadow.camera.top = s
    key.shadow.camera.bottom = -s
    this.scene.add(key)

    const rim = new THREE.DirectionalLight(0x2fe6d6, 0.4)
    rim.position.set(-40, 30, -40)
    this.scene.add(rim)

    // Subtle accent point lights for atmosphere
    const p1 = new THREE.PointLight(0x2fe6d6, 0.6, 60)
    p1.position.set(-22, 8, 12)
    const p2 = new THREE.PointLight(0x5ab8ff, 0.5, 60)
    p2.position.set(22, 8, -28)
    this.scene.add(p1, p2)
  }

  spawn(records) {
    for (const r of records) {
      if (this.avatars.has(r.id)) continue
      const av = new AgentAvatar(r)
      av.placeIn(this.zones, r.zone)
      av.syncTo(r, this.zones)
      av.body.userData.agentId = r.id
      av.head.userData.agentId = r.id
      this.avatars.set(r.id, av)
      this.scene.add(av.group)
    }
  }

  sync(records) {
    const seen = new Set()
    for (const r of records) {
      seen.add(r.id)
      const av = this.avatars.get(r.id)
      if (av) av.syncTo(r, this.zones)
      else {
        // new agent appeared
        const na = new AgentAvatar(r)
        na.placeIn(this.zones, r.zone)
        na.syncTo(r, this.zones)
        na.body.userData.agentId = r.id
        this.avatars.set(r.id, na)
        this.scene.add(na.group)
      }
    }
    // remove agents that vanished
    for (const [id, av] of this.avatars) {
      if (!seen.has(id)) {
        this.scene.remove(av.group)
        av.dispose()
        this.avatars.delete(id)
        if (id === this._selectedId) this.select(null)
      }
    }
  }

  onHover(cb) { this._hoverCb = cb }
  onSelect(cb) { this._selectCb = cb }

  // Programmatically set selection (e.g. when the operator clicks the roster).
  select(id) {
    if (this._selectedId && this.avatars.has(this._selectedId)) {
      this.avatars.get(this._selectedId).setSelected(false)
    }
    this._selectedId = id
    if (id && this.avatars.has(id)) this.avatars.get(id).setSelected(true)
    const rec = id ? this.avatars.get(id)?.record ?? null : null
    if (this._selectCb) this._selectCb(rec)
  }

  selectedId() { return this._selectedId }

  _onPointerMove(e) {
    this.pointer.x = (e.clientX / window.innerWidth) * 2 - 1
    this.pointer.y = -(e.clientY / window.innerHeight) * 2 + 1
    this._lastScreen = { x: e.clientX, y: e.clientY }
  }

  // Treat a pointerup as a "click" only if the pointer barely moved (so dragging
  // to orbit the camera doesn't select/deselect agents).
  _onPointerUp(e) {
    if (!this._downAt) return
    const moved = Math.hypot(e.clientX - this._downAt.x, e.clientY - this._downAt.y)
    this._downAt = null
    if (moved > 6) return
    this.pointer.x = (e.clientX / window.innerWidth) * 2 - 1
    this.pointer.y = -(e.clientY / window.innerHeight) * 2 + 1
    const rec = this._pick()
    this.select(rec ? rec.id : null)
  }

  _pick() {
    this.ray.setFromCamera(this.pointer, this.camera)
    const meshes = []
    this.avatars.forEach((av) => meshes.push(av.body, av.head))
    const hits = this.ray.intersectObjects(meshes, false)
    if (hits.length) {
      const id = hits[0].object.userData.agentId
      return this.avatars.get(id)?.record ?? null
    }
    return null
  }

  start() {
    const loop = () => {
      this._raf = requestAnimationFrame(loop)
      const dt = Math.min(this._clock.getDelta(), 0.05)
      const time = this._clock.elapsedTime

      this.avatars.forEach((av) => av.update(dt, time))
      this.controls.update()

      // hover detection (cheap; runs every frame on a small mesh set)
      if (this._hoverCb && this._lastScreen) {
        const rec = this._pick()
        if (rec !== this._hovered) {
          this._hovered = rec
        }
        this._hoverCb(rec, this._lastScreen)
      }

      this.renderer.render(this.scene, this.camera)
    }
    loop()
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
  }
}
