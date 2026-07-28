/**
 * A ZIP reader that does exactly one thing: stream the single XML member of a MAME
 * listxml archive without ever holding it in memory.
 *
 * **Why not a dependency.** The repository has one runtime dependency (`ajv`) and that
 * restraint is deliberate. What is actually needed here is: locate the end-of-central-
 * directory record, read the central directory, and hand `zlib.createInflateRaw()` a byte
 * range of the file. Node 24 supplies the decompressor and the CRC-32; the rest is a few
 * dozen bytes of little-endian header parsing. A general ZIP library would bring
 * encryption, ZIP64, multi-disk archives, path traversal defences and a supply chain, all
 * to read one member of one file published by one project.
 *
 * **What is deliberately not supported**, each with a named error rather than a wrong
 * answer: ZIP64 (`mame0288lx.zip` is 19 MB compressed, 309 MB inflated — a ZIP64 archive
 * would mean MAME crossed 4 GB and this reader should be revisited, not silently
 * misparse), encrypted entries, multi-disk archives, and compression methods other than
 * *stored* and *deflate*.
 *
 * **What is checked.** The inflated bytes are CRC-32'd against the central directory as
 * they stream past, and the inflated length is compared to the declared uncompressed
 * size. A truncated or corrupt member therefore fails at the end of the parse rather than
 * yielding a short, plausible-looking XML document that quietly loses machines.
 */
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createInflateRaw, crc32 } from 'node:zlib';
import { Transform, type Readable } from 'node:stream';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/** Bit 0 of the general-purpose flags. Encrypted members are refused, not guessed at. */
const FLAG_ENCRYPTED = 0x0001;

/** The end-of-central-directory record is 22 bytes plus a comment of at most 65535. */
const MAX_EOCD_SEARCH = 22 + 0xffff;

/** One central-directory entry, in the fields this reader uses. */
export interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  /** Offset of the local file header, which the data follows at a variable distance. */
  readonly localHeaderOffset: number;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`zip: ${message}`);
}

/**
 * Reads the central directory. Only the tail of the file is touched: the EOCD record is
 * found by scanning backwards for its signature, which then points at the directory.
 */
export async function readCentralDirectory(path: string): Promise<ZipEntry[]> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, MAX_EOCD_SEARCH);
    const tail = Buffer.allocUnsafe(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);

    let eocd = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY) {
        eocd = index;
        break;
      }
    }
    assert(eocd >= 0, `${path} has no end-of-central-directory record; it is not a zip archive`);

    const entryCount = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    assert(
      directoryOffset !== ZIP64_SENTINEL && directorySize !== ZIP64_SENTINEL,
      `${path} is a ZIP64 archive; this reader is deliberately 32-bit only (see the module comment)`,
    );

    const directory = Buffer.allocUnsafe(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);

    const entries: ZipEntry[] = [];
    let cursor = 0;
    for (let index = 0; index < entryCount; index += 1) {
      assert(
        cursor + 46 <= directory.length && directory.readUInt32LE(cursor) === CENTRAL_FILE_HEADER,
        `${path}: central directory entry ${index} has a bad signature`,
      );
      const flags = directory.readUInt16LE(cursor + 8);
      assert((flags & FLAG_ENCRYPTED) === 0, `${path}: encrypted entries are not supported`);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const compressedSize = directory.readUInt32LE(cursor + 20);
      const uncompressedSize = directory.readUInt32LE(cursor + 24);
      const localHeaderOffset = directory.readUInt32LE(cursor + 42);
      assert(
        compressedSize !== ZIP64_SENTINEL &&
          uncompressedSize !== ZIP64_SENTINEL &&
          localHeaderOffset !== ZIP64_SENTINEL,
        `${path}: entry ${index} needs ZIP64; this reader is deliberately 32-bit only`,
      );
      entries.push({
        // UTF-8 regardless of the language-encoding flag: MAME's asset uses ASCII names,
        // and CP437 would differ only for bytes this archive never contains.
        name: directory.toString('utf8', cursor + 46, cursor + 46 + nameLength),
        method: directory.readUInt16LE(cursor + 10),
        crc32: directory.readUInt32LE(cursor + 16),
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      });
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/**
 * Where an entry's compressed bytes start. The central directory records the offset of
 * the *local* header, whose name and extra fields are independently sized from the
 * central copy — a detail that is easy to miss and produces a stream that inflates to
 * garbage rather than an error.
 */
async function dataOffset(path: string, entry: ZipEntry): Promise<number> {
  const handle = await open(path, 'r');
  try {
    const header = Buffer.allocUnsafe(30);
    await handle.read(header, 0, 30, entry.localHeaderOffset);
    assert(
      header.readUInt32LE(0) === LOCAL_FILE_HEADER,
      `${path}: '${entry.name}' has no local file header at ${entry.localHeaderOffset}`,
    );
    return entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }
}

/** The single entry whose name ends in `.xml`. Anything else is an unexpected archive. */
export function soleXmlEntry(entries: readonly ZipEntry[]): ZipEntry {
  const [only, ...rest] = entries.filter((entry) => entry.name.toLowerCase().endsWith('.xml'));
  assert(
    only !== undefined && rest.length === 0,
    `expected exactly one .xml member, found ${only === undefined ? 0 : rest.length + 1} in ` +
      `[${entries.map((entry) => entry.name).join(', ')}]`,
  );
  return only;
}

/**
 * A readable stream of one entry's uncompressed bytes.
 *
 * The stream **errors at end-of-data** if the inflated bytes do not match the entry's
 * CRC-32 and declared length. That check is the whole reason this is not three lines of
 * `createInflateRaw`: a listxml archive that lost bytes in transit would otherwise parse
 * fine and simply contain fewer machines, and "fewer machines" is not a shape any
 * downstream assertion can distinguish from a MAME release that removed some.
 *
 * The verification runs in a pass-through `Transform` rather than a `data` listener,
 * because a listener would put the source in flowing mode before the caller subscribes
 * and silently drop the first chunks.
 */
export async function openZipEntry(path: string, entry: ZipEntry): Promise<Readable> {
  assert(
    entry.method === METHOD_STORED || entry.method === METHOD_DEFLATE,
    `${path}: '${entry.name}' uses compression method ${entry.method}; only stored and deflate are supported`,
  );
  const start = await dataOffset(path, entry);

  let checksum = 0;
  let length = 0;
  const verify = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      checksum = crc32(chunk, checksum);
      length += chunk.length;
      callback(null, chunk);
    },
    flush(callback) {
      if (length !== entry.uncompressedSize) {
        callback(
          new Error(
            `zip: '${entry.name}' inflated to ${length} bytes, expected ${entry.uncompressedSize}`,
          ),
        );
      } else if (checksum !== entry.crc32) {
        callback(
          new Error(
            `zip: '${entry.name}' has CRC-32 ${checksum.toString(16)}, expected ${entry.crc32.toString(16)}`,
          ),
        );
      } else {
        callback();
      }
    },
  });

  if (entry.compressedSize === 0) {
    verify.end();
    return verify;
  }

  // `pipe` does not forward errors, and a read error that never reaches the stream the
  // caller holds is a hang rather than a failure. Every stage forwards into the one
  // returned, so a bad read, a corrupt deflate stream and a CRC mismatch all surface the
  // same way to the same consumer.
  const forward = (error: Error): void => {
    verify.destroy(error);
  };
  const source = createReadStream(path, { start, end: start + entry.compressedSize - 1 });
  source.on('error', forward);
  if (entry.method === METHOD_DEFLATE) {
    const inflate = createInflateRaw();
    inflate.on('error', forward);
    source.pipe(inflate).pipe(verify);
  } else {
    source.pipe(verify);
  }
  return verify;
}
