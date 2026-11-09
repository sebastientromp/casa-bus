import { inflateRawSync } from 'node:zlib';

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END = 0x06064b50;
const ZIP64_EXTRA = 0x0001;
const IN_ZIP64 = 0xffffffff;

function findEndOfDirectory(buf) {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === END_OF_DIRECTORY) return i;
  }
  throw new Error('Not a zip file');
}

function directoryStart(buf, end) {
  const offset = buf.readUInt32LE(end + 16);
  if (offset !== IN_ZIP64) return offset;
  const locator = end - 20;
  if (locator < 0 || buf.readUInt32LE(locator) !== ZIP64_LOCATOR) throw new Error('Damaged zip file');
  const zip64End = Number(buf.readBigUInt64LE(locator + 8));
  if (buf.readUInt32LE(zip64End) !== ZIP64_END) throw new Error('Damaged zip file');
  return Number(buf.readBigUInt64LE(zip64End + 48));
}

/** Sizes too big for the classic fields live in an extra record, in a fixed order. */
function applyZip64(buf, start, length, entry) {
  for (let p = start; p + 4 <= start + length; ) {
    const id = buf.readUInt16LE(p);
    const size = buf.readUInt16LE(p + 2);
    if (id === ZIP64_EXTRA) {
      let v = p + 4;
      for (const field of ['size', 'compressed', 'offset']) {
        if (entry[field] !== IN_ZIP64) continue;
        entry[field] = Number(buf.readBigUInt64LE(v));
        v += 8;
      }
      return;
    }
    p += 4 + size;
  }
}

/** Reads the named files from a zip archive, returning { name: Buffer }. */
export function readZip(bytes, wanted) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names = new Set(wanted);
  const files = {};
  let p = directoryStart(buf, findEndOfDirectory(buf));
  while (p + 46 <= buf.length && buf.readUInt32LE(p) === DIRECTORY_ENTRY) {
    const method = buf.readUInt16LE(p + 10);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    const entry = { compressed: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24), offset: buf.readUInt32LE(p + 42) };
    applyZip64(buf, p + 46 + nameLength, extraLength, entry);
    if (names.has(name)) {
      const dataStart = entry.offset + 30 + buf.readUInt16LE(entry.offset + 26) + buf.readUInt16LE(entry.offset + 28);
      const data = buf.subarray(dataStart, dataStart + entry.compressed);
      if (method === 0) files[name] = data;
      else if (method === 8) files[name] = inflateRawSync(data);
      else throw new Error(`Unsupported compression in ${name}`);
    }
    p += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
