// Conferência de imagens enviadas pelo painel.
//
// Antes só os primeiros bytes eram olhados, então um arquivo qualquer que começasse com a assinatura de um JPEG passava. Agora o
// arquivo precisa ter a ESTRUTURA de uma imagem de verdade (cabeçalho com largura e altura plausíveis e o fim do arquivo no lugar),
// e o tamanho em pixels tem limite (imagem gigante trava o navegador de quem abre o site). SVG nunca entra: pode carregar script.
export type ImageInfo = { type: 'image/webp' | 'image/jpeg' | 'image/png' | 'image/gif' | 'image/avif'; width: number; height: number };

export const MAX_SIDE = 12_000;
export const MAX_PIXELS = 50_000_000;

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u32le = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

// CRC-32 (PNG), em tabela.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(b: Uint8Array, from: number, to: number): number {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function png(b: Uint8Array): { width: number; height: number } | null {
  // Assinatura + primeiro bloco IHDR (13 bytes de dados) com CRC certo.
  if (b.length < 45 || ascii(b, 1, 4) !== 'PNG' || b[0] !== 0x89 || u32be(b, 8) !== 13 || ascii(b, 12, 16) !== 'IHDR') return null;
  if (crc32(b, 12, 29) !== u32be(b, 29)) return null;
  // Termina com o bloco IEND (12 bytes: tamanho 0, "IEND" e o CRC fixo).
  const end = b.length - 12;
  if (u32be(b, end) !== 0 || ascii(b, end + 4, end + 8) !== 'IEND') return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function jpeg(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 125 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  let dims: { width: number; height: number } | null = null;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i] === 0xff && i < b.length) i++; // bytes de preenchimento
    const marker = b[i++];
    if (marker === 0xd9) return null; // fim da imagem antes de qualquer dado
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // marcadores sem tamanho
    const length = u16be(b, i);
    if (length < 2 || i + length > b.length) return null;
    // SOF0..SOF15 (menos DHT, JPG e DAC) trazem a altura e a largura.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) return null;
      dims = { height: u16be(b, i + 3), width: u16be(b, i + 5) };
    }
    if (marker === 0xda) {
      // A partir daqui vêm os dados da imagem; precisa haver um marcador de fim (FFD9) depois deles.
      if (!dims) return null;
      for (let j = b.length - 2; j > i + length; j--) if (b[j] === 0xff && b[j + 1] === 0xd9) return dims;
      return null;
    }
    i += length;
  }
  return null;
}

function webp(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 12) !== 'WEBP') return null;
  // O tamanho declarado no RIFF precisa caber no arquivo.
  if (u32le(b, 4) + 8 > b.length) return null;
  const chunk = ascii(b, 12, 16);
  if (chunk === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = u32le(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  return null;
}

function gif(b: Uint8Array): { width: number; height: number } | null {
  const head = ascii(b, 0, 6);
  if (b.length < 14 || (head !== 'GIF87a' && head !== 'GIF89a')) return null;
  if (b[b.length - 1] !== 0x3b) return null; // terminador do GIF
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

function avif(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 32 || ascii(b, 4, 8) !== 'ftyp') return null;
  const brand = ascii(b, 8, 12);
  if (brand !== 'avif' && brand !== 'avis') return null;
  // A caixa "ispe" guarda a largura e a altura (versão/flags de 4 bytes, depois dois números de 32 bits).
  for (let i = 12; i + 20 <= b.length; i++) {
    if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) return { width: u32be(b, i + 8), height: u32be(b, i + 12) };
  }
  return null;
}

// Tipo e tamanho reais da imagem, ou null se o arquivo não é uma imagem inteira e plausível.
export function inspectImage(bytes: Uint8Array): ImageInfo | null {
  const candidates: [ImageInfo['type'], (b: Uint8Array) => { width: number; height: number } | null][] = [
    ['image/webp', webp],
    ['image/jpeg', jpeg],
    ['image/png', png],
    ['image/gif', gif],
    ['image/avif', avif],
  ];
  for (const [type, read] of candidates) {
    const dims = read(bytes);
    if (!dims) continue;
    if (!(dims.width >= 1 && dims.height >= 1) || dims.width > MAX_SIDE || dims.height > MAX_SIDE || dims.width * dims.height > MAX_PIXELS) return null;
    return { type, ...dims };
  }
  return null;
}
