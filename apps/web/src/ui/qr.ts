// A small QR code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1 to 9 (up to 180 bytes),
// enough for a tel: link with a forwarding code. Made here so the code never leaves the browser for a QR service.
// Follows the structure of Project Nayuki's QR Code generator (MIT): place the function patterns, write the
// interleaved data and Reed-Solomon codewords in the zigzag order, then pick the mask with the lowest penalty.

/** Error correction codewords per block and number of blocks at level M, for versions 1 to 9. */
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22]
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5]
const MAX_VERSION = 9

/** The modules of a QR code, `true` for dark, row by row; `size` × `size`. */
export type QrMatrix = { size: number; modules: boolean[][] }

/** Data modules of a version, minus function patterns and format/version info. */
function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2
    result -= (25 * align - 10) * align - 55
    if (ver >= 7) result -= 36
  }
  return result
}

const dataCodewords = (ver: number) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver - 1]! * BLOCKS[ver - 1]!

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return []
  const count = Math.floor(ver / 7) + 2
  const step = Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2
  const size = ver * 4 + 17
  const result = [6]
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos)
  return result
}

// ---- Reed-Solomon over GF(256), polynomial 0x11D ----
function gfMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root)
      if (j + 1 < result.length) result[j] = result[j]! ^ result[j + 1]!
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ result.shift()!
    result.push(0)
    divisor.forEach((coef, i) => {
      result[i] = result[i]! ^ gfMultiply(coef, factor)
    })
  }
  return result
}

/** The data codewords for `bytes` in byte mode, padded to the version's capacity. */
function encodeData(bytes: Uint8Array, ver: number): number[] {
  const bits: number[] = []
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  put(0b0100, 4)
  put(bytes.length, 8) // versions 1 to 9 count bytes in 8 bits
  for (const b of bytes) put(b, 8)
  const capacity = dataCodewords(ver) * 8
  put(0, Math.min(4, capacity - bits.length))
  put(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8)
  const words: number[] = []
  for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0))
  return words
}

/** Splits the data into blocks, adds each block's error correction, and interleaves them. */
function withErrorCorrection(data: readonly number[], ver: number): number[] {
  const blocks = BLOCKS[ver - 1]!
  const eccLen = ECC_PER_BLOCK[ver - 1]!
  const raw = Math.floor(rawDataModules(ver) / 8)
  const shortBlocks = blocks - (raw % blocks)
  const shortLen = Math.floor(raw / blocks)
  const divisor = rsDivisor(eccLen)
  const parts: number[][] = []
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1))
    k += dat.length
    const block = [...dat, ...rsRemainder(dat, divisor)]
    if (i < shortBlocks) block.splice(shortLen - eccLen, 0, 0) // placeholder, skipped below
    parts.push(block)
  }
  const result: number[] = []
  for (let i = 0; i < parts[0]!.length; i++)
    parts.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= shortBlocks) result.push(block[i]!)
    })
  return result
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x, _y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

class Grid {
  readonly size: number
  readonly modules: boolean[][]
  readonly fixed: boolean[][]
  readonly ver: number
  constructor(ver: number) {
    this.ver = ver
    this.size = ver * 4 + 17
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
    this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
  }
  set(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark
    this.fixed[y]![x] = true
  }

  drawFunctionPatterns() {
    const { size } = this
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0)
      this.set(i, 6, i % 2 === 0)
    }
    this.drawFinder(3, 3)
    this.drawFinder(size - 4, 3)
    this.drawFinder(3, size - 4)
    const align = alignmentPositions(this.ver)
    const last = align.length - 1
    align.forEach((ax, i) =>
      align.forEach((ay, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) this.set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }),
    )
    this.drawFormat(0) // reserves the format area; drawn again with the real mask
    this.drawVersion()
  }

  drawFinder(cx: number, cy: number) {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        this.set(x, y, dist !== 2 && dist !== 4)
      }
  }

  /** Level M (format bits 00) and the mask, BCH-protected and XOR-ed with 0x5412. */
  drawFormat(mask: number) {
    const data = mask // (0b00 << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    const bit = (i: number) => ((bits >>> i) & 1) !== 0
    const { size } = this
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i))
    this.set(8, 7, bit(6))
    this.set(8, 8, bit(7))
    this.set(7, 8, bit(8))
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, bit(i))
    this.set(8, size - 8, true)
  }

  drawVersion() {
    if (this.ver < 7) return
    let rem = this.ver
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (this.ver << 12) | rem
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.set(a, b, dark)
      this.set(b, a, dark)
    }
  }

  drawCodewords(words: readonly number[]) {
    const { size } = this
    let i = 0
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < size; vert++)
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? size - 1 - vert : vert
          if (!this.fixed[y]![x] && i < words.length * 8) {
            this.modules[y]![x] = ((words[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0
            i++
          }
        }
    }
  }

  applyMask(mask: number) {
    const fn = MASKS[mask]!
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++) if (!this.fixed[y]![x] && fn(x, y)) this.modules[y]![x] = !this.modules[y]![x]
  }

  penalty(): number {
    const { size, modules } = this
    const at = (x: number, y: number, rows: boolean) => (rows ? modules[y]![x]! : modules[x]![y]!)
    let score = 0
    for (const rows of [true, false])
      for (let y = 0; y < size; y++) {
        let run = 1
        for (let x = 1; x <= size; x++) {
          if (x < size && at(x, y, rows) === at(x - 1, y, rows)) run++
          else {
            if (run >= 5) score += run - 2
            run = 1
          }
        }
        for (let x = 0; x + 11 <= size; x++) {
          const line = Array.from({ length: 11 }, (_, k) => at(x + k, y, rows))
          const finder = [true, false, true, true, true, false, true]
          const left = line.slice(0, 4).every(d => !d) && finder.every((d, k) => line[4 + k] === d)
          const right = finder.every((d, k) => line[k] === d) && line.slice(7).every(d => !d)
          if (left || right) score += 40
        }
      }
    for (let y = 0; y + 1 < size; y++)
      for (let x = 0; x + 1 < size; x++) {
        const c = modules[y]![x]
        if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) score += 3
      }
    const dark = modules.reduce((n, row) => n + row.filter(Boolean).length, 0)
    const total = size * size
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
    return score
  }
}

/** The smallest QR code (level M) holding `text` as UTF-8; `mask` forces a mask pattern (tests). */
export function encodeQr(text: string, mask?: number): QrMatrix {
  const bytes = new TextEncoder().encode(text)
  let ver = 1
  // 4 bits mode + 8 bits count + the data must fit the version's data codewords.
  while (ver <= MAX_VERSION && 12 + bytes.length * 8 > dataCodewords(ver) * 8) ver++
  // i18n-ignore: a programming error (the codes shown are a few characters), never on screen
  if (ver > MAX_VERSION) throw new Error(`Too long for a QR code here: ${bytes.length} bytes`)
  const words = withErrorCorrection(encodeData(bytes, ver), ver)
  let best: { grid: Grid; score: number } | null = null
  for (const m of mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [mask]) {
    const grid = new Grid(ver)
    grid.drawFunctionPatterns()
    grid.drawCodewords(words)
    grid.applyMask(m)
    grid.drawFormat(m)
    const score = mask === undefined ? grid.penalty() : 0
    if (!best || score < best.score) best = { grid, score }
  }
  return { size: best!.grid.size, modules: best!.grid.modules }
}

/** An SVG path drawing the dark modules, one unit per module, offset by the quiet zone `margin`. */
export function qrPath(qr: QrMatrix, margin = 4): string {
  const parts: string[] = []
  qr.modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) parts.push(`M${x + margin} ${y + margin}h1v1h-1z`)
    }),
  )
  return parts.join('')
}
