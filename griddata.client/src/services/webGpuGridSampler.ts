import type { CellReadings } from './visualCodec'
import type { Corners } from './matrixVision'

// WebGPU is intentionally typed through the tiny surface used here. The project
// targets browsers that may not ship WebGPU's TypeScript declarations yet; runtime
// capability detection keeps those browsers on the proven CPU sampler.
type GpuObject = any

const GPU_TEXTURE_COPY_DST = 0x02
const GPU_TEXTURE_BINDING = 0x04
const GPU_TEXTURE_RENDER_ATTACHMENT = 0x10
const GPU_BUFFER_MAP_READ = 0x01
const GPU_BUFFER_COPY_SRC = 0x04
const GPU_BUFFER_COPY_DST = 0x08
const GPU_BUFFER_UNIFORM = 0x40
const GPU_BUFFER_STORAGE = 0x80
const GPU_MAP_READ = 0x01

const SAMPLE_SHADER = /* wgsl */ `
struct Params {
  hx: vec4<f32>,
  hy: vec4<f32>,
  dims: vec4<f32>,
  opts: vec4<f32>,
}

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let grid_w = u32(params.dims.z);
  let grid_h = u32(params.dims.w);
  let index = gid.x;
  if (index >= grid_w * grid_h) { return; }

  let gx = index % grid_w;
  let gy = index / grid_w;
  let u = (f32(gx) + 0.5) / f32(grid_w);
  let v = (f32(gy) + 0.5) / f32(grid_h);
  let weight = params.hx.w * u + params.hy.w * v + 1.0;
  let centre = vec2<i32>(
    i32((params.hx.x * u + params.hx.y * v + params.hx.z) / weight),
    i32((params.hy.x * u + params.hy.y * v + params.hy.z) / weight),
  );

  let width = i32(params.dims.x);
  let height = i32(params.dims.y);
  let radius = i32(params.opts.x);
  let binary = params.opts.y > 0.5;
  var rgb = vec3<f32>(0.0);
  var lum_sum = 0.0;
  var lum_sq = 0.0;
  var count = 0.0;
  for (var dy = -radius; dy <= radius; dy = dy + 1) {
      let y = centre.y + dy;
      if (y < 0 || y >= height) { continue; }
      let texture_y = select(y, height - 1 - y, params.opts.z > 0.5);
    for (var dx = -radius; dx <= radius; dx = dx + 1) {
      let x = centre.x + dx;
      if (x < 0 || x >= width) { continue; }
      let pixel = textureLoad(source, vec2<i32>(x, texture_y), 0).rgb * 255.0;
      let lum = select(dot(pixel, vec3<f32>(0.299, 0.587, 0.114)), pixel.g, binary);
      rgb = rgb + pixel;
      lum_sum = lum_sum + lum;
      lum_sq = lum_sq + lum * lum;
      count = count + 1.0;
    }
  }

  let base = index * 5u;
  if (count == 0.0) {
    for (var j = 0u; j < 5u; j = j + 1u) { output[base + j] = 0.0; }
    return;
  }
  let mean_rgb = rgb / count;
  let mean_lum = lum_sum / count;
  let variance = max(0.0, lum_sq / count - mean_lum * mean_lum);
  output[base] = mean_rgb.r;
  output[base + 1u] = mean_rgb.g;
  output[base + 2u] = mean_rgb.b;
  output[base + 3u] = mean_lum;
  output[base + 4u] = 1.0 / (1.0 + variance / (28.0 * 28.0));
}
`

export interface GpuSampleResult {
  readings: CellReadings
  ms: number
}

export interface WebGpuInitResult {
  sampler: WebGpuGridSampler | null
  reason: string
}

/** Heckbert unit-square → quad coefficients, shared with the WGSL sampler. */
export function homographyCoefficients(q: Corners): Float32Array {
  const x0 = q.tl.x, x1 = q.tr.x, x2 = q.br.x, x3 = q.bl.x
  const y0 = q.tl.y, y1 = q.tr.y, y2 = q.br.y, y3 = q.bl.y
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3
  let a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    a = x1 - x0; b = x3 - x0; c = x0
    d = y1 - y0; e = y3 - y0; f = y0
    g = 0; h = 0
  } else {
    const den = dx1 * dy2 - dx2 * dy1
    if (Math.abs(den) < 1e-12) throw new Error('Degenerate grid homography')
    g = (dx3 * dy2 - dx2 * dy3) / den
    h = (dx1 * dy3 - dx3 * dy1) / den
    a = x1 - x0 + g * x1; b = x3 - x0 + h * x3; c = x0
    d = y1 - y0 + g * y1; e = y3 - y0 + h * y3; f = y0
  }
  return new Float32Array([a, b, c, g, d, e, f, h])
}

export class WebGpuGridSampler {
  private device: GpuObject
  private pipeline: GpuObject
  private texture: GpuObject | null = null
  private textureW = 0
  private textureH = 0
  private output: GpuObject | null = null
  private staging: GpuObject | null = null
  private outputBytes = 0
  private uniform: GpuObject
  private dead = false

  private constructor(device: GpuObject, pipeline: GpuObject) {
    this.device = device
    this.pipeline = pipeline
    this.uniform = device.createBuffer({ size: 64, usage: GPU_BUFFER_UNIFORM | GPU_BUFFER_COPY_DST })
    device.lost.then(() => { this.dead = true }).catch(() => { this.dead = true })
  }

  static async create(): Promise<WebGpuInitResult> {
    try {
      const gpu = (globalThis.navigator as Navigator & { gpu?: GpuObject }).gpu
      if (!gpu) return { sampler: null, reason: 'navigator.gpu unavailable' }
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
      if (!adapter) return { sampler: null, reason: 'no WebGPU adapter' }
      const device = await adapter.requestDevice()
      const descriptor = {
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: SAMPLE_SHADER }), entryPoint: 'main' },
      }
      const pipeline = typeof device.createComputePipelineAsync === 'function'
        ? await device.createComputePipelineAsync(descriptor)
        : device.createComputePipeline(descriptor)
      return { sampler: new WebGpuGridSampler(device, pipeline), reason: 'ready' }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { sampler: null, reason: reason || 'WebGPU initialization failed' }
    }
  }

  upload(bitmap: ImageBitmap, width: number, height: number): boolean {
    if (this.dead) return false
    try {
      if (!this.texture || width !== this.textureW || height !== this.textureH) {
        this.texture?.destroy()
        this.texture = this.device.createTexture({
          size: { width, height },
          format: 'rgba8unorm',
          // copyExternalImageToTexture is specified as an external-image copy,
          // but Chromium's implementation uses a render path and requires
          // RENDER_ATTACHMENT as well. Without it the validation layer can leave
          // a readable all-zero texture: exactly the field score 0.000.
          usage: GPU_TEXTURE_COPY_DST | GPU_TEXTURE_BINDING | GPU_TEXTURE_RENDER_ATTACHMENT,
        })
        this.textureW = width
        this.textureH = height
      }
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: this.texture },
        { width, height },
      )
      return true
    } catch {
      this.dead = true
      return false
    }
  }

  async sample(corners: Corners, gridW: number, gridH: number, binary: boolean, flipY = false): Promise<GpuSampleResult | null> {
    if (this.dead || !this.texture) return null
    const started = performance.now()
    try {
      const cells = gridW * gridH
      const bytes = cells * 5 * 4
      if (!this.output || bytes !== this.outputBytes) {
        this.output?.destroy(); this.staging?.destroy()
        this.output = this.device.createBuffer({ size: bytes, usage: GPU_BUFFER_STORAGE | GPU_BUFFER_COPY_SRC })
        this.staging = this.device.createBuffer({ size: bytes, usage: GPU_BUFFER_MAP_READ | GPU_BUFFER_COPY_DST })
        this.outputBytes = bytes
      }

      const h = homographyCoefficients(corners)
      const top = Math.hypot(corners.tr.x - corners.tl.x, corners.tr.y - corners.tl.y)
      const bottom = Math.hypot(corners.br.x - corners.bl.x, corners.br.y - corners.bl.y)
      const left = Math.hypot(corners.bl.x - corners.tl.x, corners.bl.y - corners.tl.y)
      const right = Math.hypot(corners.br.x - corners.tr.x, corners.br.y - corners.tr.y)
      const cellPx = Math.min((top + bottom) * 0.5 / gridW, (left + right) * 0.5 / gridH)
      const radius = binary ? Math.min(1, Math.max(0, Math.floor(cellPx / 4))) : Math.max(0, Math.floor(cellPx / 4))
      const params = new Float32Array(16)
      params.set(h.subarray(0, 4), 0)
      params.set(h.subarray(4, 8), 4)
      params.set([this.textureW, this.textureH, gridW, gridH], 8)
      params.set([radius, binary ? 1 : 0, flipY ? 1 : 0, 0], 12)
      this.device.queue.writeBuffer(this.uniform, 0, params)

      const bind = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.texture.createView() },
          { binding: 1, resource: { buffer: this.output } },
          { binding: 2, resource: { buffer: this.uniform } },
        ],
      })
      const encoder = this.device.createCommandEncoder()
      const pass = encoder.beginComputePass()
      pass.setPipeline(this.pipeline)
      pass.setBindGroup(0, bind)
      pass.dispatchWorkgroups(Math.ceil(cells / 128))
      pass.end()
      encoder.copyBufferToBuffer(this.output, 0, this.staging, 0, bytes)
      this.device.queue.submit([encoder.finish()])
      await this.staging.mapAsync(GPU_MAP_READ)
      const packed = new Float32Array(this.staging.getMappedRange().slice(0))
      this.staging.unmap()

      const r = binary ? new Float32Array(0) : new Float32Array(cells)
      const g = binary ? new Float32Array(0) : new Float32Array(cells)
      const b = binary ? new Float32Array(0) : new Float32Array(cells)
      const lum = new Float32Array(cells)
      const rel = new Float32Array(cells)
      for (let i = 0; i < cells; i++) {
        const p = i * 5
        if (!binary) { r[i] = packed[p]; g[i] = packed[p + 1]; b[i] = packed[p + 2] }
        lum[i] = packed[p + 3]
        rel[i] = packed[p + 4]
      }
      return { readings: { r, g, b, lum, rel }, ms: performance.now() - started }
    } catch {
      this.dead = true
      return null
    }
  }
}
