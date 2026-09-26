"""Fetch and analyze a reference video for the remix workflow.

Usage:
  python fetch_reference.py <url-or-local-file> <project_dir> [--whisper-model small]

Does Steps 0-1 of the skill in one go:
  - downloads a public TikTok/YouTube/Instagram/X video with yt-dlp (or copies a local file)
  - writes source/source.mp4, source/info.json (duration, fps, size, audio, uploader, url)
  - writes source/contact_sheet.jpg (one frame per second, tiled)
  - writes script/source_transcript.json + .txt (faster-whisper, word timestamps)

Needs: yt-dlp, ffmpeg/ffprobe on PATH; `pip install faster-whisper` for transcription.
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


def run(cmd: list[str]) -> str:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd)}\n{result.stderr[-2000:]}")
    return result.stdout


def download(source: str, out_dir: Path) -> tuple[Path, dict]:
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / "source.mp4"
    local = Path(source)
    if local.exists():
        shutil.copyfile(local, target)
        return target, {"source": str(local.resolve())}
    meta_raw = run(["yt-dlp", "--no-playlist", "--dump-single-json", source])
    meta = json.loads(meta_raw)
    run([
        "yt-dlp", "--no-playlist",
        "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "--merge-output-format", "mp4",
        "-o", str(target), "--force-overwrites", source,
    ])
    keep = {k: meta.get(k) for k in ("id", "title", "uploader", "uploader_id", "webpage_url", "duration", "upload_date")}
    return target, keep


def probe(video: Path) -> dict:
    data = json.loads(run([
        "ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(video),
    ]))
    v = next((s for s in data["streams"] if s["codec_type"] == "video"), {})
    num, _, den = (v.get("r_frame_rate") or "0/1").partition("/")
    return {
        "duration": float(data["format"].get("duration", 0)),
        "width": v.get("width"),
        "height": v.get("height"),
        "fps": round(float(num) / float(den or 1), 3) if float(den or 1) else None,
        "has_audio": any(s["codec_type"] == "audio" for s in data["streams"]),
    }


def contact_sheet(video: Path, out: Path, duration: float) -> None:
    cols = 6
    rows = max(1, -(-int(duration + 1) // cols))
    run([
        "ffmpeg", "-y", "-v", "error", "-i", str(video),
        # One frame per second, left to right, top to bottom (tile N = second N-1).
        "-vf", f"fps=1,scale=240:-2,tile={cols}x{rows}:padding=4:color=black",
        "-frames:v", "1", str(out),
    ])


def transcribe(video: Path, out_dir: Path, model_name: str) -> None:
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper not installed; skipping transcript (pip install faster-whisper)")
        return
    def run_model(device: str, compute: str):
        model = WhisperModel(model_name, device=device, compute_type=compute)
        segments, info = model.transcribe(str(video), word_timestamps=True, vad_filter=True)
        return list(segments), info  # decoding happens here, so GPU errors surface now

    try:
        segments, info = run_model("auto", "auto")
    except (RuntimeError, OSError) as err:  # e.g. an NVIDIA GPU without the CUDA libraries
        print(f"GPU transcription failed ({err}); using the CPU")
        segments, info = run_model("cpu", "int8")
    rows = []
    for seg in segments:
        rows.append({
            "start": round(seg.start, 2),
            "end": round(seg.end, 2),
            "text": seg.text.strip(),
            "words": [{"start": round(w.start, 2), "end": round(w.end, 2), "word": w.word} for w in (seg.words or [])],
        })
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "source_transcript.json").write_text(
        json.dumps({"language": info.language, "segments": rows}, indent=2), encoding="utf-8")
    (out_dir / "source_transcript.txt").write_text(
        "\n".join(f"[{r['start']:6.2f}-{r['end']:6.2f}] {r['text']}" for r in rows), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("project_dir")
    parser.add_argument("--whisper-model", default="small")
    args = parser.parse_args()

    project = Path(args.project_dir)
    video, meta = download(args.source, project / "source")
    info = {**meta, **probe(video)}
    (project / "source" / "info.json").write_text(json.dumps(info, indent=2), encoding="utf-8")
    contact_sheet(video, project / "source" / "contact_sheet.jpg", info["duration"])
    if info["has_audio"]:
        transcribe(video, project / "script", args.whisper_model)
    print(json.dumps({"ok": True, "video": str(video), **info}))


if __name__ == "__main__":
    main()
