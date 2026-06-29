// metrics.js
// Real host metrics from the Node process — so the dashboard's "host" panel
// reflects the actual machine the orchestrator runs on, not a simulation.
//
// CPU%: os.loadavg() returns 0 on Windows, so we sample os.cpus() and compute
// the busy/idle delta between two reads. DISK is sampled cheaply via statfs
// when available, otherwise reported as a stable placeholder.

import os from 'node:os'
import { statfs } from 'node:fs'

function cpuTimes() {
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  for (const c of cpus) {
    for (const t of Object.values(c.times)) total += t
    idle += c.times.idle
  }
  return { idle, total }
}

export class Metrics {
  constructor() {
    this._prev = cpuTimes()
    this._cpu = 0
    this._disk = 0
    this._diskCheckedAt = 0
  }

  // Percentage of CPU time spent busy since the previous call.
  _sampleCpu() {
    const now = cpuTimes()
    const idleDelta = now.idle - this._prev.idle
    const totalDelta = now.total - this._prev.total
    this._prev = now
    if (totalDelta <= 0) return this._cpu
    const busy = 1 - idleDelta / totalDelta
    // light smoothing so the meter doesn't jitter
    this._cpu = Math.round((this._cpu * 0.4 + busy * 100 * 0.6))
    return Math.max(0, Math.min(100, this._cpu))
  }

  _sampleMem() {
    const used = os.totalmem() - os.freemem()
    return Math.round((used / os.totalmem()) * 100)
  }

  // Disk is relatively expensive + static; refresh at most every ~10s.
  _sampleDisk(nowMs) {
    if (nowMs - this._diskCheckedAt < 10000 && this._disk) return this._disk
    this._diskCheckedAt = nowMs
    const root = process.platform === 'win32' ? 'C:\\' : '/'
    statfs(root, (err, st) => {
      if (err || !st || !st.blocks) return
      const usedFrac = 1 - st.bfree / st.blocks
      this._disk = Math.round(usedFrac * 100)
    })
    return this._disk || 0
  }

  // Returns { cpu, mem, disk, net } — net is derived from agent load by the
  // orchestrator, so we only fill the host-level fields here.
  sample(nowMs) {
    return {
      cpu: this._sampleCpu(),
      mem: this._sampleMem(),
      disk: this._sampleDisk(nowMs),
    }
  }

  info() {
    return {
      cores: os.cpus().length,
      platform: os.platform(),
      hostname: os.hostname(),
      totalMemGb: Math.round(os.totalmem() / 1e9),
    }
  }
}
