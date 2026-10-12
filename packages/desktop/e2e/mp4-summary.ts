/**
 * Reads an MP4's tracks and duration straight from its ISO BMFF boxes. CI
 * runners carry no ffprobe, and the export assertions need only what the
 * container itself records: each track's handler and the movie duration.
 */

export interface Mp4Summary {
  /** Each track's handler type, in file order: `vide`, `soun`, … */
  tracks: string[];
  /** Movie duration in seconds, from `moov/mvhd`. */
  duration: number;
}

/** The only boxes walked: the path from the top level to each track's `hdlr`. */
const CONTAINERS = new Set(['moov', 'trak', 'mdia']);

export function readMp4Summary(bytes: Buffer): Mp4Summary {
  const tracks: string[] = [];
  let duration: number | undefined;

  const walk = (start: number, end: number): void => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = bytes.readUInt32BE(offset);
      const type = bytes.toString('latin1', offset + 4, offset + 8);
      let header = 8;
      if (size === 1) {
        size = Number(bytes.readBigUInt64BE(offset + 8));
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < header || offset + size > end) {
        throw new Error(`Malformed MP4: box '${type}' at ${String(offset)} overruns its parent`);
      }
      const body = offset + header;
      if (CONTAINERS.has(type)) {
        walk(body, offset + size);
      } else if (type === 'mvex') {
        // A fragmented file's mvhd duration is zero; its timing lives in moof boxes.
        throw new Error('Fragmented MP4 is not supported: its duration is not in mvhd');
      } else if (type === 'mvhd') {
        // Full box: version 1 widens the times and duration to 64 bits.
        duration =
          bytes[body] === 1
            ? Number(bytes.readBigUInt64BE(body + 24)) / bytes.readUInt32BE(body + 20)
            : bytes.readUInt32BE(body + 16) / bytes.readUInt32BE(body + 12);
      } else if (type === 'hdlr') {
        // Full box header, then pre_defined, then the handler type.
        tracks.push(bytes.toString('latin1', body + 8, body + 12));
      }
      offset += size;
    }
  };

  walk(0, bytes.length);
  if (duration === undefined) throw new Error('Malformed MP4: no movie header (mvhd)');
  return { tracks, duration };
}
