import { wordsToBytes, decodeBech32NoChecksum, decodeU32LE } from './bech32';

// ---------------------------------------------------------------------------
// wordsToBytes
// ---------------------------------------------------------------------------

describe('wordsToBytes', () => {

  it('returns an empty array for empty input', () => {
    expect(wordsToBytes([])).toEqual([]);
  });

  it('pads a single 5-bit word to 8 bits (high bits)', () => {
    // [31] = 0b11111 → padded to 0b11111_000 = 248
    expect(wordsToBytes([31])).toEqual([248]);
  });

  it('pads a single zero word to one zero byte', () => {
    expect(wordsToBytes([0])).toEqual([0]);
  });

  it('packs 8 zero words into exactly 5 bytes with no padding byte', () => {
    // 8 × 5 = 40 bits — evenly divisible, no partial byte added
    expect(wordsToBytes([0, 0, 0, 0, 0, 0, 0, 0])).toEqual([0, 0, 0, 0, 0]);
  });

  it('correctly re-packs the EX1qqqsqqq words into the expected bytes', () => {
    // "qqqsqqq" → charset values [0,0,0,16,0,0,0]
    // Expected: LE bytes [0,1,0,0,0] (timestamp 256 in extractExpiry)
    expect(wordsToBytes([0, 0, 0, 16, 0, 0, 0])).toEqual([0, 1, 0, 0, 0]);
  });

  it('packs two non-zero words correctly', () => {
    // [1, 0] = 0b00001_00000 = 10 bits → byte 0b00001_000=8, padding byte 0b00_000000=0
    expect(wordsToBytes([1, 0])).toEqual([8, 0]);
  });

});

// ---------------------------------------------------------------------------
// decodeBech32NoChecksum
// ---------------------------------------------------------------------------

describe('decodeBech32NoChecksum', () => {

  it('throws when no 1-separator is present', () => {
    expect(() => decodeBech32NoChecksum('nochars')).toThrow('No separator found');
  });

  it('throws on an invalid character in the data part', () => {
    expect(() => decodeBech32NoChecksum('ex1!')).toThrow("Invalid character '!'");
  });

  it('throws on the character "b" which is not in the bech32 charset', () => {
    // 'b' is not in the bech32 charset (uses q,p,z,r,y,9,x,8,g,f,2,t,v,d,w,0,s,3,j,n,5,4,k,h,c,e,6,m,u,a,7,l)
    expect(() => decodeBech32NoChecksum('ex1bcd')).toThrow("Invalid character 'b'");
  });

  it('extracts the HRP (human-readable part) correctly', () => {
    const { hrp } = decodeBech32NoChecksum('ex1qq');
    expect(hrp).toBe('ex');
  });

  it('is case-insensitive — uppercase input gives lowercase HRP', () => {
    const upper = decodeBech32NoChecksum('EX1QQ');
    const lower = decodeBech32NoChecksum('ex1qq');
    expect(upper.hrp).toBe('ex');
    expect(upper.bytes).toEqual(lower.bytes);
  });

  it('decodes a known EX1 fragment used by extractExpiry', () => {
    // "EX1qqqsqqq" → hrp="ex", bytes=[0,1,0,0,0]
    const { hrp, bytes } = decodeBech32NoChecksum('EX1qqqsqqq');
    expect(hrp).toBe('ex');
    expect(bytes).toEqual([0, 1, 0, 0, 0]);
  });

  it('handles a multi-character HRP', () => {
    // "abc1" → hrp="abc", data="q" (charset[0]=0), bytes=[0]
    const { hrp, bytes } = decodeBech32NoChecksum('abc1q');
    expect(hrp).toBe('abc');
    expect(bytes).toEqual([0]);
  });

  it('uses the first 1 as the separator (not the last)', () => {
    // "a1bc1q" → hrp="a", dataPart="bc1q"
    // 'b' is invalid → should throw
    expect(() => decodeBech32NoChecksum('a1bc1q')).toThrow("Invalid character 'b'");
  });

});

// ---------------------------------------------------------------------------
// decodeU32LE
// ---------------------------------------------------------------------------

describe('decodeU32LE', () => {

  it('decodes four zero bytes to 0', () => {
    expect(decodeU32LE([0, 0, 0, 0])).toBe(0);
  });

  it('decodes [1,0,0,0] to 1', () => {
    expect(decodeU32LE([1, 0, 0, 0])).toBe(1);
  });

  it('decodes [0,1,0,0] to 256', () => {
    expect(decodeU32LE([0, 1, 0, 0])).toBe(256);
  });

  it('decodes [0,0,1,0] to 65536', () => {
    expect(decodeU32LE([0, 0, 1, 0])).toBe(65536);
  });

  it('decodes [0,0,0,1] to 16777216', () => {
    expect(decodeU32LE([0, 0, 0, 1])).toBe(16_777_216);
  });

  it('decodes a realistic Unix timestamp', () => {
    // 1_700_000_000 = 0x6553F100 → LE bytes [0x00, 0xF1, 0x53, 0x65]
    expect(decodeU32LE([0x00, 0xF1, 0x53, 0x65])).toBe(1_700_000_000);
  });

  it('ignores extra bytes beyond the first four', () => {
    expect(decodeU32LE([1, 0, 0, 0, 99, 99])).toBe(1);
  });

});
