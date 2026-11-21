import { gzipSync } from 'node:zlib';

/** Builds one ustar entry (header + padded data) for test fixtures. */
export function tarEntry(name: string, content: string | Buffer = '', type = '0', linkName = ''): Buffer {
  const data = Buffer.from(content);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 'ascii');
  h.write('0000000\0', 108, 'ascii');
  h.write('0000000\0', 116, 'ascii');
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  h.write('00000000000\0', 136, 'ascii');
  h.fill(' ', 148, 156);
  h.write(type, 156, 'ascii');
  h.write(linkName, 157, 100, 'utf8');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad]);
}

export function tgz(entries: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

export function agentPackage(version = '1.2.3', extra: Buffer[] = []): Buffer {
  const manifest = JSON.stringify({ name: 'ims-agent', version, entry: 'dist/ims-agent.js', node: '>=20.19.0', builtAt: '2026-09-30T00:00:00.000Z' });
  return tgz([
    tarEntry('./', '', '5'),
    tarEntry('./manifest.json', manifest),
    tarEntry('./dist/', '', '5'),
    tarEntry('./dist/ims-agent.js', 'console.log("agent");\n'.repeat(100)),
    tarEntry('./installer/', '', '5'),
    tarEntry('./installer/install.sh', '#!/usr/bin/env bash\necho install\n'),
    ...extra,
  ]);
}
