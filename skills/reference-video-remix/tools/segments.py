"""Split a video into <=10 s pieces for Vids AI Edit, and stitch the edited pieces back.

Split (muted pieces, cut at natural points: scene cuts, then speech pauses, else hard 10 s):
  python segments.py split <video.mp4> <out_dir> [--max 10] [--min 3] [--transcript t.json] [--cuts cuts.json]
    -> out_dir/NN_source_muted.mp4 + out_dir/segments.json [{"n","start","end"}]

Stitch (edited pieces in order, re-timed to the original lengths, original audio restored):
  python segments.py stitch <segments.json> <edited_dir> <out.mp4> [--audio <original.mp4>] [--size 1080x1920]
    edited_dir holds NN_edited.mp4 (same NN as the split). --audio puts the source's
    original soundtrack back under the new picture (omit it to keep the edits' own audio).
"""

import argparse
import json
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


def plan(total: float, max_len: float, min_len: float, cuts: list[float], pauses: list[float]) -> list[tuple[float, float]]:
    """Greedy: from each start, end at the latest scene cut, else latest pause, within max_len."""
    out, start = [], 0.0
    while total - start > max_len:
        lo, hi = start + min_len, start + max_len
        best = max((c for c in cuts if lo <= c <= hi), default=None)
        if best is None:
            best = max((p for p in pauses if lo <= p <= hi), default=None)
        if best is None:
            best = hi
        out.append((round(start, 2), round(best, 2)))
        start = best
    if out and total - start < min_len:  # fold a tiny tail into the previous piece if it still fits
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
    pauses: list[float] = []
    if args.transcript and Path(args.transcript).exists():
        data = json.loads(Path(args.transcript).read_text(encoding="utf-8"))
        segs = data.get("segments", data) if isinstance(data, dict) else data
        pauses = [s["end"] for s in segs]  # sentence ends
    pieces = plan(total, args.max, args.min, sorted(cuts), sorted(pauses))
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
