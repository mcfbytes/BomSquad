/**
 * The purpose-built ZIP reader.
 *
 * Archives are synthesised here rather than checked in, so each test states the byte
 * layout it is about. The one that matters most is the corruption case: an archive whose
 * member no longer matches its CRC-32 must *fail*, because a listxml that quietly lost
 * bytes would parse fine and simply contain fewer machines — and "fewer machines" is
 * indistinguishable from a MAME release that removed some.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openZipEntry, readCentralDirectory, soleXmlEntry } from '../src/mame/zip.js';

const dir = mkdtempSync(join(tmpdir(), 'bomsquad-zip-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Member {
  readonly name: string;
  readonly content: Buffer;
  /** 8 = deflate, 0 = stored. */
  readonly method: number;
}

/** Builds a minimal single-disk archive: local headers, central directory, EOCD. */
function buildZip(members: readonly Member[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8');
    const data = member.method === 8 ? deflateRawSync(member.content) : member.content;
    const checksum = crc32(member.content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(member.method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(member.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(member.method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(member.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

function write(name: string, members: readonly Member[]): string {
  const path = join(dir, name);
  writeFileSync(path, buildZip(members));
  return path;
}

async function readAll(path: string, entryName: string): Promise<string> {
  const entries = await readCentralDirectory(path);
  const entry = entries.find((candidate) => candidate.name === entryName);
  if (entry === undefined) throw new Error(`${path} has no member named '${entryName}'`);
  const chunks: Buffer[] = [];
  for await (const chunk of await openZipEntry(path, entry)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const xml = '<mame build="test">' + '<machine name="a"/>'.repeat(500) + '</mame>';

describe('reading the central directory', () => {
  it('lists every member with its sizes and method', async () => {
    const path = write('two.zip', [
      { name: 'a.xml', content: Buffer.from(xml), method: 8 },
      { name: 'notes.txt', content: Buffer.from('hello'), method: 0 },
    ]);
    const entries = await readCentralDirectory(path);
    expect(entries.map((entry) => entry.name)).toEqual(['a.xml', 'notes.txt']);
    expect(entries[0]?.uncompressedSize).toBe(xml.length);
    expect(entries[0]?.method).toBe(8);
    expect(entries[1]?.method).toBe(0);
  });

  it('rejects a file that is not an archive at all', async () => {
    const path = join(dir, 'garbage.zip');
    writeFileSync(path, Buffer.alloc(100, 0x41));
    await expect(readCentralDirectory(path)).rejects.toThrow(/not a zip archive/);
  });
});

describe('picking the listxml member', () => {
  it('finds the one .xml among other members', async () => {
    const path = write('mixed.zip', [
      { name: 'readme.txt', content: Buffer.from('x'), method: 0 },
      { name: 'mame0288.xml', content: Buffer.from(xml), method: 8 },
    ]);
    expect(soleXmlEntry(await readCentralDirectory(path)).name).toBe('mame0288.xml');
  });

  it('refuses to guess when there is more than one', async () => {
    const path = write('twoxml.zip', [
      { name: 'a.xml', content: Buffer.from(xml), method: 8 },
      { name: 'b.xml', content: Buffer.from(xml), method: 8 },
    ]);
    const entries = await readCentralDirectory(path);
    expect(() => soleXmlEntry(entries)).toThrow(/expected exactly one \.xml member, found 2/);
  });
});

describe('streaming a member', () => {
  it('inflates a deflated member exactly', async () => {
    const path = write('deflate.zip', [{ name: 'a.xml', content: Buffer.from(xml), method: 8 }]);
    expect(await readAll(path, 'a.xml')).toBe(xml);
  });

  it('passes a stored member through unchanged', async () => {
    const path = write('stored.zip', [{ name: 'a.xml', content: Buffer.from(xml), method: 0 }]);
    expect(await readAll(path, 'a.xml')).toBe(xml);
  });

  it('reads the second member, whose data does not start at a fixed offset', async () => {
    const path = write('second.zip', [
      { name: 'first-with-a-long-name.bin', content: Buffer.from('0123456789'), method: 0 },
      { name: 'a.xml', content: Buffer.from(xml), method: 8 },
    ]);
    expect(await readAll(path, 'a.xml')).toBe(xml);
  });

  /** Byte offsets into a one-stored-member archive built by {@link buildZip}. */
  const NAME = 'a.xml';
  const dataAt = 30 + NAME.length;
  const centralAt = (contentLength: number): number => dataAt + contentLength;

  it('errors when the member no longer matches its CRC-32', async () => {
    // Flip one byte of the stored payload, leaving every header intact. Without the CRC
    // check this reads back as perfectly valid XML with one character changed.
    const content = Buffer.from(xml);
    const bytes = buildZip([{ name: NAME, content, method: 0 }]);
    bytes.writeUInt8(bytes.readUInt8(dataAt + 10) ^ 0x20, dataAt + 10);
    const path = join(dir, 'corrupt.zip');
    writeFileSync(path, bytes);
    await expect(readAll(path, NAME)).rejects.toThrow(/CRC-32/);
  });

  it('errors when the member is shorter than its header claims', async () => {
    // Shrink the *central directory's* compressed size — the field the reader trusts — so
    // the stream ends 16 bytes early while the declared uncompressed size stays honest.
    const content = Buffer.from(xml);
    const bytes = buildZip([{ name: NAME, content, method: 0 }]);
    bytes.writeUInt32LE(content.length - 16, centralAt(content.length) + 20);
    const path = join(dir, 'short.zip');
    writeFileSync(path, bytes);
    await expect(readAll(path, NAME)).rejects.toThrow(/inflated to \d+ bytes, expected/);
  });
});
