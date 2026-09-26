"""Split a video into <=10 s pieces for Vids AI Edit, and stitch the edited pieces back.

Split (muted pieces of the ORIGINAL video, cut where the speaker stops: scene cuts inside a
pause, else the longest pause from word timestamps + silence detection; never mid-word):
  python segments.py split <video.mp4> <out_dir> [--max 10] [--min 3] [--transcript t.json] [--cuts cuts.json]
    -> out_dir/NN_source_muted.mp4 + out_dir/segments.json [{"n","start","end"}]

Stitch (edited pieces in order, re-timed to the original lengths, original audio restored):
  python segments.py stitch <segments.json> <edited_dir> <out.mp4> [--audio <original.mp4>] [--size 1080x1920]
    edited_dir holds NN_edited.mp4 (same NN as the split). --audio puts the source's
    original soundtrack back under the new picture (omit it to keep the edits' own audio).
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str]) -> str:
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"failed: {' '.join(cmd[:8])} ...\n{r.stderr[-1500:]}")
    return r.stdout


def duration(path: Path) -> float:
    return float(run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)]).strip())


def silences(video: Path) -> list[tuple[float, float]]:
    """Quiet stretches (>= 0.25 s under -35 dB): where the speaker stops."""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-i", str(video), "-af", "silencedetect=noise=-35dB:d=0.25",
                        "-f", "null", "-"], capture_output=True, text=True)
    starts = [float(x) for x in re.findall(r"silence_start: ([0-9.]+)", r.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([0-9.]+)", r.stderr)]
    return list(zip(starts, ends))


def plan(total: float, max_len: float, min_len: float, cuts: list[float],
         pauses: list[tuple[float, float, float]]) -> list[tuple[float, float]]:
    """Choose each end point inside (start+min, start+max], best first:
    1) a scene cut that falls in a pause, 2) the longest pause (speaker stops),
    3) a scene cut, 4) only as a last resort the max length.
    pauses = (middle_time, length, weight); cutting in the middle of a pause never clips a word."""
    out, start = [], 0.0
    def in_pause(t: float) -> bool:
        return any(abs(t - m) <= ln / 2 + 0.05 for m, ln, _ in pauses)
    while total - start > max_len:
        lo, hi = start + min_len, start + max_len
        window_cuts = [c for c in cuts if lo <= c <= hi]
        window_pauses = [p for p in pauses if lo <= p[0] <= hi]
        best = next((c for c in sorted(window_cuts, reverse=True) if in_pause(c)), None)
        if best is None and window_pauses:
            # Longest pause wins; later ones break ties so pieces stay long.
            best = max(window_pauses, key=lambda p: (round(p[1] * p[2], 2), p[0]))[0]
        if best is None and window_cuts:
            best = max(window_cuts)
        if best is None:
            best = hi
        out.append((round(start, 2), round(best, 2)))
        start = best
    if out and total - start < min_len:
        prev_start, _ = out[-1]
        if total - prev_start <= max_len:
            out[-1] = (prev_start, round(total, 2))
            return out
    out.append((round(start, 2), round(total, 2)))
    return out


def split(args: argparse.Namespace) -> None:
    video, out = Path(args.video), Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    total = duration(video)
    cuts = json.loads(Path(args.cuts).read_text()) if args.cuts and Path(args.cuts).exists() else []
    pauses: list[tuple[float, float, float]] = []
    if args.transcript and Path(args.transcript).exists():
        data = json.loads(Path(args.transcript).read_text(encoding="utf-8"))
        segs = data.get("segments", data) if isinstance(data, dict) else data
        words = [w for sg in segs for w in sg.get("words", [])]
        if words:  # gaps between words; sentence ends count double
            for a, b in zip(words, words[1:]):
                gap = b["start"] - a["end"]
                if gap >= 0.15:
                    end_of_sentence = a["word"].strip()[-1:] in ".?!"
                    pauses.append(((a["end"] + b["start"]) / 2, gap, 2.0 if end_of_sentence else 1.0))
        else:
            for a, b in zip(segs, segs[1:]):
                pauses.append(((a["end"] + b["start"]) / 2, max(b["start"] - a["end"], 0.2), 2.0))
    for a, b in silences(video):  # the audio itself: catches pauses the transcript misses
        pauses.append(((a + b) / 2, b - a, 1.5))
    pieces = plan(total, args.max, args.min, sorted(cuts), pauses)
    info = []
    for i, (a, b) in enumerate(pieces, 1):
        target = out / f"{i:02d}_source_muted.mp4"
        run(["ffmpeg", "-y", "-v", "error", "-ss", f"{a}", "-to", f"{b}", "-i", str(video), "-an",
             "-c:v", "libx264", "-preset", "medium", "-crf", "18", str(target)])
        info.append({"n": i, "start": a, "end": b, "file": target.name})
    (out / "segments.json").write_text(json.dumps(info, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "total": total, "segments": info}))


def stitch(args: argparse.Namespace) -> None:
    segs = json.loads(Path(args.segments).read_text(encoding="utf-8"))
    edited = Path(args.edited_dir)
    w, h = args.size.split("x")
    tmp = edited / "_retimed"
    tmp.mkdir(exist_ok=True)
    parts = []
    for s in segs:
        src = edited / f"{s['n']:02d}_edited.mp4"
        if not src.exists():
            sys.exit(f"missing {src} (edit piece {s['n']} first)")
        want = s["end"] - s["start"]
        have = duration(src)
        # Re-time each edit to its source length so the original audio stays in sync.
        speed = have / want if want > 0 else 1.0
        part = tmp / f"{s['n']:02d}.mp4"
        run(["ffmpeg", "-y", "-v", "error", "-i", str(src), "-an",
             "-vf", f"setpts=PTS/{speed:.6f},scale={w}:{h}:force_original_aspect_ratio=decrease,"
                    f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p",
             "-t", f"{want:.3f}", "-c:v", "libx264", "-preset", "medium", "-crf", "18", str(part)])
        parts.append(part)
    listing = tmp / "list.txt"
    listing.write_text("".join(f"file '{p.resolve().as_posix()}'\n" for p in parts), encoding="utf-8")
    video_only = tmp / "video_only.mp4"
    run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(video_only)])
    out = Path(args.out)
    if args.audio:
        run(["ffmpeg", "-y", "-v", "error", "-i", str(video_only), "-i", args.audio,
             "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", str(out)])
    else:
        run(["ffmpeg", "-y", "-v", "error", "-i", str(video_only), "-c", "copy", str(out)])
    print(json.dumps({"ok": True, "out": str(out), "duration": duration(out), "pieces": len(parts)}))


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("split")
    s.add_argument("video"); s.add_argument("out_dir")
    s.add_argument("--max", type=float, default=10.0); s.add_argument("--min", type=float, default=3.0)
    s.add_argument("--transcript"); s.add_argument("--cuts")
    t = sub.add_parser("stitch")
    t.add_argument("segments"); t.add_argument("edited_dir"); t.add_argument("out")
    t.add_argument("--audio"); t.add_argument("--size", default="1080x1920")
    args = ap.parse_args()
    split(args) if args.cmd == "split" else stitch(args)


if __name__ == "__main__":
    main()
