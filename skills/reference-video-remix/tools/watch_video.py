"""Let an agent "watch" a video: keyframes at every cut + regular samples, laid out
with the timed transcript in one report the agent can read (text + images).

Usage:
  python watch_video.py <video.mp4> <out_dir> [--every 1.0] [--scene 0.3] [--whisper-model small]

Writes to out_dir:
  frames/f_<seconds>.jpg   one frame per sample (every N s) and at each detected cut
  sheet_<k>.jpg            contact sheets of 12 frames each (3x4), in time order
  cuts.json                detected cut times (seconds)
  transcript.json          timed transcript (reused from script/source_transcript.json if given)
  WATCH.md                 timeline: time -> frame file -> words spoken, plus the cuts

Read WATCH.md first, then open the sheet images (or single frames) to see the shots.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd[:6])} ...\n{result.stderr[-1500:]}")
    return result


def duration_of(video: Path) -> float:
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)])
    return float(out.stdout.strip() or 0)


def cell_size(video: Path) -> tuple[int, int]:
    """Sheet cell matching the video shape (portrait, landscape or square)."""
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(video)])
    w, h = (int(x) for x in out.stdout.strip().split(",")[:2])
    return (480, max(2, round(480 * h / w / 2) * 2)) if w >= h else (max(2, round(480 * w / h / 2) * 2), 480)


def detect_cuts(video: Path, threshold: float) -> list[float]:
    # showinfo prints pts_time for frames whose scene-change score passes the threshold.
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-i", str(video), "-vf", f"select='gt(scene,{threshold})',showinfo", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    return [round(float(t), 2) for t in re.findall(r"pts_time:([0-9.]+)", result.stderr)]


def grab(video: Path, t: float, out: Path) -> None:
    run(["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.2f}", "-i", str(video), "-frames:v", "1",
         "-vf", "scale=360:-2", "-q:v", "4", str(out)])


def transcribe(video: Path, model_name: str) -> list[dict]:
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper not installed; no transcript (pip install faster-whisper)")
        return []

    def go(device: str, compute: str) -> list:
        model = WhisperModel(model_name, device=device, compute_type=compute)
        segments, _ = model.transcribe(str(video), vad_filter=True)
        return list(segments)

    try:
        segments = go("auto", "auto")
    except (RuntimeError, OSError):
        segments = go("cpu", "int8")
    return [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segments]


def sheets(frames: list[tuple[float, Path]], out_dir: Path, cell: tuple[int, int]) -> list[Path]:
    made = []
    for k in range(0, len(frames), 12):
        chunk = frames[k:k + 12]
        listing = out_dir / f"_sheet_{k // 12 + 1}.txt"
        listing.write_text("".join(f"file '{p.resolve().as_posix()}'\n" for _, p in chunk), encoding="utf-8")
        target = out_dir / f"sheet_{k // 12 + 1}.jpg"
        run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(listing),
             "-vf", f"scale={cell[0]}:{cell[1]}:force_original_aspect_ratio=decrease,pad={cell[0]}:{cell[1]}:(ow-iw)/2:(oh-ih)/2,tile=4x3:padding=4",
             "-frames:v", "1", str(target)])
        listing.unlink()
        made.append(target)
    return made


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("out_dir")
    ap.add_argument("--every", type=float, default=1.0, help="seconds between regular samples")
    ap.add_argument("--scene", type=float, default=0.3, help="cut sensitivity (lower = more cuts)")
    ap.add_argument("--whisper-model", default="small")
    ap.add_argument("--transcript", help="existing transcript JSON (e.g. script/source_transcript.json)")
    args = ap.parse_args()

    video = Path(args.video)
    out = Path(args.out_dir)
    (out / "frames").mkdir(parents=True, exist_ok=True)
    dur = duration_of(video)
    cuts = detect_cuts(video, args.scene)

    times = {round(i * args.every, 2) for i in range(int(dur / args.every) + 1) if i * args.every < dur}
    times |= {min(round(c + 0.1, 2), round(dur - 0.05, 2)) for c in cuts}  # just after each cut
    frames = []
    for t in sorted(times):
        path = out / "frames" / f"f_{t:06.2f}.jpg"
        grab(video, t, path)
        if path.exists():
            frames.append((t, path))

    if args.transcript and Path(args.transcript).exists():
        data = json.loads(Path(args.transcript).read_text(encoding="utf-8"))
        transcript = [{k: s[k] for k in ("start", "end", "text")} for s in data.get("segments", data)]
    else:
        transcript = transcribe(video, args.whisper_model)

    sheet_files = sheets(frames, out, cell_size(video))
    (out / "cuts.json").write_text(json.dumps(cuts), encoding="utf-8")
    (out / "transcript.json").write_text(json.dumps(transcript, indent=2), encoding="utf-8")

    def spoken(t0: float, t1: float) -> str:
        return " ".join(s["text"] for s in transcript if s["start"] < t1 and s["end"] > t0)

    lines = [
        f"# Watch report: {video.name}",
        f"Duration {dur:.1f} s | {len(cuts)} cuts at: {', '.join(f'{c:.1f}' for c in cuts) or 'none'}",
        f"Contact sheets (12 frames each, left to right, top to bottom): {', '.join(p.name for p in sheet_files)}",
        "",
        "## Transcript",
        *(f"- [{s['start']:.1f}-{s['end']:.1f}] {s['text']}" for s in transcript),
        "",
        "## Timeline (frame -> what is said around it; CUT = new shot)",
    ]
    cut_set = {min(round(c + 0.1, 2), round(dur - 0.05, 2)) for c in cuts}
    for i, (t, path) in enumerate(frames):
        nxt = frames[i + 1][0] if i + 1 < len(frames) else dur
        mark = " CUT" if t in cut_set else ""
        lines.append(f"- {t:5.1f}s{mark} `frames/{path.name}` (sheet {i // 12 + 1}, #{i % 12 + 1}): {spoken(t, nxt) or '-'}")
    lines += ["", "Now open the sheets and describe: shots, framing, camera moves, gestures, props, on-screen text, and the joke's beats."]
    (out / "WATCH.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"ok": True, "report": str(out / "WATCH.md"), "sheets": [str(p) for p in sheet_files],
                      "frames": len(frames), "cuts": cuts, "duration": dur}))


if __name__ == "__main__":
    main()
