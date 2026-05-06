
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

export function wordsToBytes(words: number[]): number[] {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  
  for (const word of words) {
    buffer = (buffer << 5) | word;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  
  if (bits > 0) {
    bytes.push(buffer << (8 - bits));
  }
  
  return bytes;
}

export function decodeBech32NoChecksum(bech32String: string): { hrp: string, bytes: number[] } {
  const lower = bech32String.toLowerCase();
  const sepIndex = lower.indexOf('1');
  if (sepIndex === -1) {
    throw new Error('No separator found in bech32 string');
  }
  
  const hrp = lower.substring(0, sepIndex);
  const dataPart = lower.substring(sepIndex + 1);
  
  // Convert all characters to 5-bit values
  const words: number[] = [];
  for (const char of dataPart) {
    const val = CHARSET.indexOf(char);
    if (val === -1) {
      throw new Error(`Invalid character '${char}' in bech32 string`);
    }
    words.push(val);
  }
  
  // Convert 5-bit words to 8-bit bytes manually
  const bytes = wordsToBytes(words);
  
  return { hrp, bytes };
}

export function decodeU32LE(bytes: number[]): number {
  return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
}