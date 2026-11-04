//! What a finished `take.mp4` holds, read back from its own boxes
//! (ISO/IEC 14496-12): its size, length, keyframes and whether it has sound.
//!
//! The encoder is asked for a size, a keyframe a second and no audio, and
//! Media Foundation's H.264 encoders treat the keyframe settings as hints, so
//! a take checks what it got rather than trusting what it asked for. Only the
//! index is read: the top-level boxes are walked by their sizes, seeking past
//! the media data, so a 60 MB take costs a few kilobytes of reads whether the
//! index comes first or last.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// An index larger than this is not one a take's encoder wrote.
const MOOV_CAP: u64 = 64 << 20;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Mp4Info {
    pub width: u32,
    pub height: u32,
    pub frames: u64,
    pub duration_ms: u64,
    /// The longest stretch between keyframes, the end of the video included:
    /// the furthest a seek has to decode from.
    pub max_keyframe_gap_ms: u64,
    pub has_audio: bool,
}

/// Read the video track of the MP4 at `path`.
pub fn read(path: &Path) -> Result<Mp4Info, String> {
    let bad = |e: std::io::Error| format!("could not read {}: {e}", path.display());
    let mut file = File::open(path).map_err(bad)?;
    let len = file.metadata().map_err(bad)?.len();
    let mut at = 0u64;
    while at + 8 <= len {
        file.seek(SeekFrom::Start(at)).map_err(bad)?;
        let mut head = [0u8; 8];
        file.read_exact(&mut head).map_err(bad)?;
        let (size, header) = match be32(&head[..4]) {
            1 => {
                let mut large = [0u8; 8];
                file.read_exact(&mut large).map_err(bad)?;
                (u64::from_be_bytes(large), 16)
            }
            0 => (len - at, 8),
            n => (u64::from(n), 8),
        };
        if size < header || at + size > len {
            return Err(format!("a box in {} has a bad size", path.display()));
        }
        if &head[4..8] == b"moov" {
            if size > MOOV_CAP {
                return Err("the MP4's index is too large to be a take's".into());
            }
            let mut body = vec![0u8; usize::try_from(size - header).unwrap_or(0)];
            file.read_exact(&mut body).map_err(bad)?;
            return parse_moov(&body);
        }
        at += size;
    }
    Err(format!("{} has no index (moov box)", path.display()))
}

/// The video track described by a `moov` box's body.
pub fn parse_moov(moov: &[u8]) -> Result<Mp4Info, String> {
    let mut video = None;
    let mut has_audio = false;
    for (kind, trak) in Boxes::new(moov) {
        if &kind != b"trak" {
            continue;
        }
        let handler = descend(trak, &[b"mdia", b"hdlr"])
            .and_then(|h| h.get(8..12))
            .unwrap_or_default();
        match handler {
            b"vide" if video.is_none() => video = Some(trak),
            b"soun" => has_audio = true,
            _ => {}
        }
    }
    let trak = video.ok_or("the MP4 has no video track")?;
    let mut info = track(trak).ok_or("the MP4's video track is missing part of its index")?;
    info.has_audio = has_audio;
    Ok(info)
}

fn track(trak: &[u8]) -> Option<Mp4Info> {
    let tkhd = descend(trak, &[b"tkhd"])?;
    let size = tkhd.get(tkhd.len().checked_sub(8)?..)?;
    let mdhd = descend(trak, &[b"mdia", b"mdhd"])?;
    let (timescale, declared) = match mdhd.first()? {
        1 => (be32(mdhd.get(20..24)?), be64(mdhd.get(24..32)?)),
        _ => (be32(mdhd.get(12..16)?), u64::from(be32(mdhd.get(16..20)?))),
    };
    let stbl = descend(trak, &[b"mdia", b"minf", b"stbl"])?;
    let deltas = table(child(stbl, b"stts")?, 8)?;
    let ms = |ticks: u64| ticks * 1000 / u64::from(timescale.max(1));
    let frames: u64 = deltas.clone().map(|e| u64::from(be32(&e[..4]))).sum();
    let ticks: u64 = deltas
        .clone()
        .map(|e| u64::from(be32(&e[..4])) * u64::from(be32(&e[4..])))
        .sum();
    let total = if ticks > 0 { ticks } else { declared };

    // Decode time of each sample, by number from 1, as stts spells it.
    let start_of = |sample: u64| {
        let (mut n, mut t) = (1u64, 0u64);
        for e in deltas.clone() {
            let (count, delta) = (u64::from(be32(&e[..4])), u64::from(be32(&e[4..])));
            if sample < n + count {
                return t + (sample - n) * delta;
            }
            n += count;
            t += count * delta;
        }
        t
    };
    let gap = match child(stbl, b"stss").and_then(|s| table(s, 4)) {
        Some(sync) => {
            let times: Vec<u64> = sync.map(|e| start_of(u64::from(be32(e)))).collect();
            let tail = total.saturating_sub(times.last().copied().unwrap_or(0));
            let head = times.first().copied().unwrap_or(total);
            times
                .windows(2)
                .map(|w| w[1].saturating_sub(w[0]))
                .chain([head, tail])
                .max()
                .unwrap_or(total)
        }
        // No sync table: every sample is a keyframe.
        None => deltas
            .clone()
            .map(|e| u64::from(be32(&e[4..])))
            .max()
            .unwrap_or(0),
    };
    Some(Mp4Info {
        width: be32(&size[..4]) >> 16,
        height: be32(&size[4..]) >> 16,
        frames,
        duration_ms: ms(total),
        max_keyframe_gap_ms: ms(gap),
        has_audio: false,
    })
}

/// A full box's table: an entry count after the version and flags, then
/// entries of `width` bytes. `None` when the count overruns the box.
fn table(body: &[u8], width: usize) -> Option<std::slice::ChunksExact<'_, u8>> {
    let count = usize::try_from(be32(body.get(4..8)?)).ok()?;
    let entries = body.get(8..8 + count.checked_mul(width)?)?;
    Some(entries.chunks_exact(width))
}

fn child<'a>(body: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    Boxes::new(body).find(|(k, _)| k == kind).map(|(_, b)| b)
}

fn descend<'a>(mut body: &'a [u8], path: &[&[u8; 4]]) -> Option<&'a [u8]> {
    for kind in path {
        body = child(body, kind)?;
    }
    Some(body)
}

fn be32(b: &[u8]) -> u32 {
    b.get(..4)
        .and_then(|b| b.try_into().ok())
        .map_or(0, u32::from_be_bytes)
}

fn be64(b: &[u8]) -> u64 {
    b.get(..8)
        .and_then(|b| b.try_into().ok())
        .map_or(0, u64::from_be_bytes)
}

/// The boxes in a buffer, in order, as (kind, body). Stops at the first box
/// whose size does not fit, rather than reading past it.
struct Boxes<'a> {
    buf: &'a [u8],
}

impl<'a> Boxes<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf }
    }
}

impl<'a> Iterator for Boxes<'a> {
    type Item = ([u8; 4], &'a [u8]);

    fn next(&mut self) -> Option<Self::Item> {
        let kind: [u8; 4] = self.buf.get(4..8)?.try_into().ok()?;
        let (size, header) = match be32(self.buf) {
            1 => (usize::try_from(be64(self.buf.get(8..16)?)).ok()?, 16),
            0 => (self.buf.len(), 8),
            n => (usize::try_from(n).ok()?, 8),
        };
        let body = self.buf.get(header..size)?;
        self.buf = self.buf.get(size..)?;
        Some((kind, body))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bx(kind: &[u8; 4], parts: &[&[u8]]) -> Vec<u8> {
        let body: Vec<u8> = parts.concat();
        let mut out = u32::try_from(body.len() + 8)
            .unwrap()
            .to_be_bytes()
            .to_vec();
        out.extend_from_slice(kind);
        out.extend(body);
        out
    }

    fn words(values: &[u32]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_be_bytes()).collect()
    }

    fn trak(handler: &[u8; 4], width: u32, height: u32, stbl: &[u8]) -> Vec<u8> {
        // tkhd v0 is 84 bytes; the size is its last eight, as 16.16.
        let mut tkhd = vec![0u8; 76];
        tkhd.extend(words(&[width << 16, height << 16]));
        let mdhd = words(&[0, 0, 0, 30, 90]);
        let hdlr = [&words(&[0, 0])[..], handler, &[0u8; 12]].concat();
        let minf = bx(b"minf", &[&bx(b"stbl", &[stbl])]);
        let mdia = bx(
            b"mdia",
            &[&bx(b"mdhd", &[&mdhd]), &bx(b"hdlr", &[&hdlr]), &minf],
        );
        bx(b"trak", &[&bx(b"tkhd", &[&tkhd]), &mdia])
    }

    fn video_stbl(sync: Option<&[u32]>) -> Vec<u8> {
        let mut stbl = bx(b"stts", &[&words(&[0, 1, 90, 1])]);
        if let Some(sync) = sync {
            let count = u32::try_from(sync.len()).unwrap();
            stbl.extend(bx(b"stss", &[&words(&[0, count]), &words(sync)]));
        }
        stbl
    }

    #[test]
    fn a_keyframe_every_thirty_frames_at_thirty_a_second_is_a_second_apart() {
        let moov = trak(b"vide", 1280, 720, &video_stbl(Some(&[1, 31, 61])));
        let info = parse_moov(&moov).unwrap();
        assert_eq!(
            info,
            Mp4Info {
                width: 1280,
                height: 720,
                frames: 90,
                duration_ms: 3_000,
                max_keyframe_gap_ms: 1_000,
                has_audio: false,
            }
        );
        let sparse = trak(b"vide", 1280, 720, &video_stbl(Some(&[1, 61])));
        assert_eq!(
            parse_moov(&sparse).unwrap().max_keyframe_gap_ms,
            2_000,
            "the gap a seek has to decode across"
        );
        let tail = trak(b"vide", 1280, 720, &video_stbl(Some(&[1, 31])));
        assert_eq!(
            parse_moov(&tail).unwrap().max_keyframe_gap_ms,
            2_000,
            "the end of the video counts"
        );
        let every = trak(b"vide", 640, 360, &video_stbl(None));
        assert_eq!(
            parse_moov(&every).unwrap().max_keyframe_gap_ms,
            33,
            "no sync table: every frame is a keyframe"
        );
    }

    #[test]
    fn an_audio_track_is_noticed_and_the_video_one_is_read() {
        let moov = [
            trak(b"soun", 0, 0, &video_stbl(None)),
            trak(b"vide", 1280, 718, &video_stbl(Some(&[1, 31, 61]))),
        ]
        .concat();
        let info = parse_moov(&moov).unwrap();
        assert!(info.has_audio);
        assert_eq!((info.width, info.height), (1280, 718));
        assert!(parse_moov(&trak(b"soun", 0, 0, &video_stbl(None))).is_err());
        let broken = bx(b"trak", &[&bx(b"tkhd", &[&[0u8; 84]])]);
        assert!(parse_moov(&broken).is_err(), "no handler, no track");
    }

    #[test]
    fn the_index_is_found_after_the_media_data_whatever_its_size_field() {
        let dir = tempfile::TempDir::new().unwrap();
        let moov = bx(
            b"moov",
            &[&trak(b"vide", 1280, 720, &video_stbl(Some(&[1, 31, 61])))],
        );
        let ftyp = bx(b"ftyp", &[b"isom", &[0, 0, 2, 0], b"isomavc1"]);
        // A 64-bit size, as an encoder writes for media data over 4 GB.
        let mut mdat = words(&[1]);
        mdat.extend_from_slice(b"mdat");
        mdat.extend((16u64 + 4_096).to_be_bytes());
        mdat.extend(vec![0xAB; 4_096]);
        let path = dir.path().join("take.mp4");
        std::fs::write(&path, [ftyp.clone(), mdat, moov.clone()].concat()).unwrap();
        assert_eq!(read(&path).unwrap().max_keyframe_gap_ms, 1_000);

        // A size of zero runs to the end of the file.
        let mut last = moov.clone();
        last[..4].copy_from_slice(&[0, 0, 0, 0]);
        std::fs::write(&path, [ftyp.clone(), last].concat()).unwrap();
        assert_eq!(read(&path).unwrap().frames, 90);

        std::fs::write(&path, &ftyp).unwrap();
        assert!(read(&path).unwrap_err().contains("no index"));
        std::fs::write(&path, [&ftyp[..], &moov[..20]].concat()).unwrap();
        assert!(read(&path).unwrap_err().contains("bad size"), "cut short");
        assert!(read(&dir.path().join("none.mp4")).is_err());
    }
}
