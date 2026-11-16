import { createHash } from "node:crypto";
import sharp from "sharp";

const MAX_PIXELS = 40_000_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Compute SHA-256 hex digest of an image buffer.
 * @param {Buffer|Uint8Array} buffer
 * @returns {string|null}
 */
export function computeSha256(buffer) {
  if (!(Buffer.isBuffer(buffer) || buffer instanceof Uint8Array) || buffer.byteLength === 0) {
    return null;
  }
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Compute a 64-bit difference hash (dHash) returned as a 16-character lowercase hex string.
 * Resizes the image to 9x8 grayscale and compares horizontally adjacent pixels.
 * Works across PNG, JPEG, WebP, GIF, TIFF, and BMP via Sharp.
 *
 * @param {Buffer|Uint8Array} imageBuffer
 * @returns {Promise<string|null>} 16-char hex string or null if unreadable/invalid
 */
export async function computePerceptualHash(imageBuffer) {
  if (!(Buffer.isBuffer(imageBuffer) || imageBuffer instanceof Uint8Array)) {
    return null;
  }
  if (imageBuffer.byteLength === 0 || imageBuffer.byteLength > MAX_IMAGE_BYTES) {
    return null;
  }

  try {
    const input = Buffer.from(imageBuffer);
    const { data, info } = await sharp(input, { limitInputPixels: MAX_PIXELS, animated: false })
      .rotate()
      .grayscale()
      .resize(9, 8, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (!data || info.width !== 9 || info.height !== 8 || data.length < 72) {
      return null;
    }

    let bits = 0n;
    for (let y = 0; y < 8; y += 1) {
      const rowOffset = y * 9;
      for (let x = 0; x < 8; x += 1) {
        bits = (bits << 1n) | (data[rowOffset + x] > data[rowOffset + x + 1] ? 1n : 0n);
      }
    }

    return bits.toString(16).padStart(16, "0");
  } catch {
    return null;
  }
}

/**
 * Compute bitwise Hamming distance between two 64-bit hex perceptual hashes.
 * @param {string|null|undefined} hashA
 * @param {string|null|undefined} hashB
 * @returns {number} Distance 0..64, or Infinity if either hash is invalid
 */
export function hammingDistance(hashA, hashB) {
  if (typeof hashA !== "string" || typeof hashB !== "string") return Infinity;
  const cleanA = hashA.trim().toLowerCase();
  const cleanB = hashB.trim().toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(cleanA) || !/^[0-9a-f]{16}$/.test(cleanB)) {
    return Infinity;
  }

  let xor = BigInt(`0x${cleanA}`) ^ BigInt(`0x${cleanB}`);
  let distance = 0;
  while (xor > 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
}

/**
 * Check whether two perceptual hashes are visually similar within a Hamming distance threshold.
 * @param {string|null|undefined} hashA
 * @param {string|null|undefined} hashB
 * @param {number} [maxDistance=8]
 * @returns {{ similar: boolean, distance: number }}
 */
export function isPerceptuallySimilar(hashA, hashB, maxDistance = 8) {
  const distance = hammingDistance(hashA, hashB);
  return {
    similar: Number.isFinite(distance) && distance <= maxDistance,
    distance,
  };
}
