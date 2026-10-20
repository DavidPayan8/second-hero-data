import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

// Crudo de ESEF comprimido con zstd (docs/esef/propuesta.md §8.1 bis; medición en docs/esef/medicion-compresion.md).
// payload_blob.content_hash sigue siendo el sha256 del cuerpo SIN comprimir y size_bytes su tamaño sin comprimir.
// Solo ESEF: EODHD y la SEC guardan los bytes tal cual ('json').
export const ESEF_BODY_FORMAT = 'json+zstd';
// PROVISIONAL: único sitio con el nivel de compresión. Cambiarlo no obliga a migrar lo guardado: zstd descomprime cualquier nivel.
export const ESEF_ZSTD_LEVEL = 19;

export const compressBody = (body: Buffer): Buffer => zstdCompressSync(body, { params: { [constants.ZSTD_c_compressionLevel]: ESEF_ZSTD_LEVEL } });

// Devuelve los bytes originales según el formato con que se guardó el blob.
export function decodeBody(body: Buffer, format: string): Buffer {
  if (format === 'json') return body;
  if (format === ESEF_BODY_FORMAT) return zstdDecompressSync(body);
  throw new Error(`body_format desconocido: ${format}`);
}
