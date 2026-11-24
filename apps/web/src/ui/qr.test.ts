import { expect, test } from 'vitest'
import { encodeQr, qrPath } from './qr.ts'

const rows = (text: string, mask?: number) =>
  encodeQr(text, mask).modules.map(r => r.map(d => (d ? '1' : '0')).join(''))

test('matches a reference encoder module for module (version 2, level M, mask 2)', () => {
  // Made with the Python qrcode package: QRCode(error_correction=M, mask_pattern=2, border=0), data "tel:%23%23004%23".
  expect(rows('tel:%23%23004%23', 2)).toEqual([
    '1111111000101001101111111',
    '1000001001010000001000001',
    '1011101011110010101011101',
    '1011101011110000001011101',
    '1011101010101111001011101',
    '1000001011100111101000001',
    '1111111010101010101111111',
    '0000000011000100000000000',
    '1011111000110011101111100',
    '0111000111101000010000100',
    '0100111111111001001011011',
    '0110010100000010010001011',
    '1100011000000001101110111',
    '1101100010001110010001100',
    '1010111111000111101101111',
    '1010110101001101101101001',
    '1010111001101011111111111',
    '0000000011100001100010010',
    '1111111000111000101010011',
    '1000001010010011100011001',
    '1011101011110001111110101',
    '1011101010101111001011011',
    '1011101010000110010001101',
    '1000001001001100101111001',
    '1111111010101011001000111',
  ])
})

test('picks the smallest version that holds the text, up to version 9', () => {
  // Level M holds 14 bytes in version 1, 26 in version 2, 42 in version 3.
  expect(encodeQr('x'.repeat(14)).size).toBe(21)
  expect(encodeQr('tel:*715035550142').size).toBe(25)
  expect(encodeQr('tel:**61*15035550142**20%23').size).toBe(29)
  expect(encodeQr('x'.repeat(180)).size).toBe(53)
  expect(() => encodeQr('x'.repeat(181))).toThrow(/Too long/)
})

test('has the three finder patterns and draws one square per dark module', () => {
  const qr = encodeQr('tel:*73')
  const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111']
  const at = (x0: number, y0: number) =>
    finder.map((_, y) =>
      qr.modules[y0 + y]!.slice(x0, x0 + 7)
        .map(d => (d ? '1' : '0'))
        .join(''),
    )
  expect(at(0, 0)).toEqual(finder)
  expect(at(qr.size - 7, 0)).toEqual(finder)
  expect(at(0, qr.size - 7)).toEqual(finder)
  const dark = qr.modules.flat().filter(Boolean).length
  expect(qrPath(qr).match(/M/g)?.length).toBe(dark)
})
