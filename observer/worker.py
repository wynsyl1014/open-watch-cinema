#!/usr/bin/env python3
"""Open Watch Cinema visual observation worker."""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

PROTOCOL_VERSION = 2
BASELINE_ENGINE = "ffmpeg-baseline-v1"
OPENCV_ENGINE = "opencv-observer-v1"
MAX_DURATION_MS = 300_000
WIDTH = 192
HEIGHT = 108


@dataclass(frozen=True)
class PpmFrame:
    width: int
    height: int
    pixels: bytes


def opencv_modules():
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
        return cv2, np
    except Exception:
        return None, None


def health_payload() -> dict:
    cv2, _ = opencv_modules()
    return {
        "ok": True,
        "protocolVersion": PROTOCOL_VERSION,
        "baselineAvailable": True,
        "baselineEngine": BASELINE_ENGINE,
        "opencvAvailable": cv2 is not None,
        "opencvVersion": str(cv2.__version__) if cv2 is not None else None,
        "opencvEngine": OPENCV_ENGINE if cv2 is not None else None,
        "pythonVersion": sys.version.split()[0],
        "ffmpegCommand": "ffmpeg",
    }


def read_token(data: bytes, index: int) -> tuple[bytes, int]:
    while index < len(data):
        if data[index] == 35:
            newline = data.find(b"\n", index)
            index = len(data) if newline < 0 else newline + 1
        elif chr(data[index]).isspace():
            index += 1
        else:
            break
    start = index
    while index < len(data) and not chr(data[index]).isspace():
        index += 1
    if start == index:
        raise ValueError("Unexpected end of PPM stream.")
    return data[start:index], index


def parse_ppm_stream(data: bytes) -> Iterable[PpmFrame]:
    index = 0
    while index < len(data):
        magic, index = read_token(data, index)
        if magic != b"P6":
            raise ValueError(f"Unsupported PPM magic {magic!r}.")
        width_token, index = read_token(data, index)
        height_token, index = read_token(data, index)
        max_token, index = read_token(data, index)
        width, height, maximum = int(width_token), int(height_token), int(max_token)
        if maximum != 255:
            raise ValueError("Only 8-bit PPM frames are supported.")
        if index >= len(data) or not chr(data[index]).isspace():
            raise ValueError("PPM header is missing its pixel separator.")
        index += 2 if data[index:index + 2] == b"\r\n" else 1
        end = index + width * height * 3
        if end > len(data):
            raise ValueError("Truncated PPM frame.")
        yield PpmFrame(width, height, data[index:end])
        index = end


def decode_frames(input_path: Path, start_ms: int, duration_ms: int, sample_fps: float) -> list[PpmFrame]:
    filters = (
        f"fps={sample_fps},"
        f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease:flags=area,"
        f"pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2:black"
    )
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-ss", f"{start_ms / 1000:.3f}", "-t", f"{duration_ms / 1000:.3f}",
        "-i", os.fspath(input_path), "-an", "-vf", filters,
        "-f", "image2pipe", "-vcodec", "ppm", "pipe:1",
    ]
    result = subprocess.run(command, capture_output=True, check=False)
    if result.returncode != 0:
        error = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(error or f"FFmpeg exited with code {result.returncode}.")
    return list(parse_ppm_stream(result.stdout))


def dominant_colour(red: float, green: float, blue: float, brightness: float) -> str:
    if brightness < 0.12:
        return "near black"
    if max(red, green, blue) - min(red, green, blue) < 0.05:
        return "neutral grey"
    if red >= green and red >= blue:
        return "warm red" if green < red * 0.82 else "warm amber"
    if blue >= red and blue >= green:
        return "cool blue"
    return "green"


def direction_label(mean_x: float, mean_y: float, strength: float) -> str:
    if strength < 0.15:
        return "still"
    angle = (math.degrees(math.atan2(mean_y, mean_x)) + 360.0) % 360.0
    labels = ["right", "down-right", "down", "down-left", "left", "up-left", "up", "up-right"]
    return labels[int((angle + 22.5) // 45.0) % 8]


def perceptual_hash(gray, cv2, np) -> str:
    resized = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA)
    low = cv2.dct(np.float32(resized))[:8, :8].flatten()
    median = float(np.median(low[1:]))
    value = 0
    for bit in low > median:
        value = (value << 1) | int(bool(bit))
    return f"{value:016x}"


def baseline_metrics(frame: PpmFrame, previous: bytes | None) -> tuple[dict, dict]:
    pixels = frame.pixels
    count = max(1, frame.width * frame.height)
    red = sum(pixels[0::3]) / count / 255.0
    green = sum(pixels[1::3]) / count / 255.0
    blue = sum(pixels[2::3]) / count / 255.0
    brightness = 0.2126 * red + 0.7152 * green + 0.0722 * blue
    saturation = sum(
        max(pixels[i:i + 3]) - min(pixels[i:i + 3])
        for i in range(0, len(pixels), 3)
    ) / count / 255.0
    difference = 0.0 if previous is None else (
        sum(abs(a - b) for a, b in zip(pixels, previous)) / len(pixels) / 255.0
    )
    metrics = {
        "brightness": round(brightness, 4),
        "saturation": round(saturation, 4),
        "averageRgb": [round(red, 4), round(green, 4), round(blue, 4)],
        "warmBias": round(red - blue, 4),
        "dominantColour": dominant_colour(red, green, blue, brightness),
        "frameDifference": round(difference, 4),
        "histogramDistance": 0.0,
        "edgeDensity": 0.0,
        "edgeChange": 0.0,
        "motionMeanPixels": 0.0,
        "motionCoverage": 0.0,
        "motionDirection": "unknown",
        "perceptualHash": None,
        "sceneScore": round(min(1.0, difference * 3.2), 4),
        "motionScore": round(min(1.0, difference * 2.0), 4),
    }
    return metrics, {"pixels": pixels}


def opencv_metrics(frame: PpmFrame, previous: dict | None, cv2, np) -> tuple[dict, dict]:
    rgb = np.frombuffer(frame.pixels, dtype=np.uint8).reshape((frame.height, frame.width, 3))
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    edges = cv2.Canny(gray, 60, 140)
    histogram = cv2.calcHist([hsv], [0, 1], None, [32, 16], [0, 180, 0, 256])
    cv2.normalize(histogram, histogram)

    red, green, blue = (float(v) for v in rgb.reshape(-1, 3).mean(axis=0) / 255.0)
    brightness = float(gray.mean() / 255.0)
    saturation = float(hsv[:, :, 1].mean() / 255.0)
    edge_density = float(np.count_nonzero(edges) / edges.size)

    difference = histogram_distance = edge_change = 0.0
    motion_mean = motion_coverage = mean_x = mean_y = 0.0
    if previous is not None:
        difference = float(cv2.absdiff(previous["gray"], gray).mean() / 255.0)
        histogram_distance = float(cv2.compareHist(
            previous["histogram"], histogram, cv2.HISTCMP_BHATTACHARYYA
        ))
        edge_change = abs(edge_density - float(previous["edgeDensity"]))
        flow = cv2.calcOpticalFlowFarneback(
            previous["gray"], gray, None, 0.5, 3, 15, 3, 5, 1.2, 0
        )
        magnitude, _ = cv2.cartToPolar(flow[:, :, 0], flow[:, :, 1])
        motion_mean = float(magnitude.mean())
        motion_coverage = float(np.mean(magnitude > 0.75))
        active = magnitude > 0.35
        if np.any(active):
            weights = magnitude[active]
            mean_x = float(np.average(flow[:, :, 0][active], weights=weights))
            mean_y = float(np.average(flow[:, :, 1][active], weights=weights))

    scene_score = min(1.0, histogram_distance * 0.62 + difference * 1.35 + edge_change * 0.85)
    motion_score = min(1.0, motion_mean / 5.5 + motion_coverage * 0.4)
    metrics = {
        "sharpness": round(float(cv2.Laplacian(gray, cv2.CV_64F).var()), 4),
        "clippedFraction": round(float(np.mean((gray < 12) | (gray > 243))), 4),
        "brightness": round(brightness, 4),
        "saturation": round(saturation, 4),
        "averageRgb": [round(red, 4), round(green, 4), round(blue, 4)],
        "warmBias": round(red - blue, 4),
        "dominantColour": dominant_colour(red, green, blue, brightness),
        "frameDifference": round(difference, 4),
        "histogramDistance": round(histogram_distance, 4),
        "edgeDensity": round(edge_density, 4),
        "edgeChange": round(edge_change, 4),
        "motionMeanPixels": round(motion_mean, 4),
        "motionCoverage": round(motion_coverage, 4),
        "motionDirection": direction_label(mean_x, mean_y, motion_mean),
        "perceptualHash": perceptual_hash(gray, cv2, np),
        "sceneScore": round(scene_score, 4),
        "motionScore": round(motion_score, 4),
    }
    return metrics, {"gray": gray, "histogram": histogram, "edgeDensity": edge_density}


def select_storyboard_indices(metrics_list: list[dict], index: int, step_ms: float, reason: str) -> list[int]:
    """Rank nearby samples, preferring a settled post-cut frame and distinct context."""
    end = min(len(metrics_list) - 1, index + int(800 / step_ms))
    candidates = list(range(index, end + 1))
    if reason == "scene_change":
        settled = [i for i in candidates if 300 <= (i - index) * step_ms <= 800
                   and metrics_list[i]["sceneScore"] < 0.34]
        if settled:
            candidates = settled

    def score(i):
        m = metrics_list[i]
        return (math.log1p(m.get("sharpness", 0)) / 8
                - m.get("clippedFraction", 0) * 1.5
                - abs(m["brightness"] - 0.5) * 0.5
                - min(m["motionMeanPixels"] / 5.5, 1) * 0.8
                - m["sceneScore"] * 0.8)

    selected = max(candidates, key=score)
    # The inspection frame is the final panel: no panel can reveal its future.
    context = list(range(max(0, index - max(2, int(1500 / step_ms))), selected))
    chosen = [selected]
    for i in sorted(context, key=score, reverse=True):
        if all(not hashes_similar(metrics_list[i], metrics_list[j]) for j in chosen):
            chosen.append(i)
        if len(chosen) == 3:
            break
    # Static shots may not contain three distinct images; retain the strip layout.
    for i in sorted(context, reverse=True) + [selected] * 3:
        if len(chosen) == 3:
            break
        if i not in chosen or i == selected:
            chosen.append(i)
    return sorted(chosen)


def hashes_similar(left: dict, right: dict) -> bool:
    a, b = left.get("perceptualHash"), right.get("perceptualHash")
    # pHash alone treats differently coloured flat frames as identical.
    return bool(a and b and (int(a, 16) ^ int(b, 16)).bit_count() <= 4
                and max(abs(x - y) for x, y in zip(left["averageRgb"], right["averageRgb"])) < 0.08)


def write_storyboard(
    input_path: Path,
    panel_times_ms: list[int],
    output_dir: Path,
    filename: str,
    cv2,
    np,
) -> None:
    panels = []
    for timestamp in panel_times_ms:
        result = subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-ss", f"{timestamp / 1000:.3f}", "-i", os.fspath(input_path),
            "-an", "-frames:v", "1", "-vf",
            "scale=512:288:force_original_aspect_ratio=decrease:flags=lanczos,"
            "pad=512:288:(ow-iw)/2:(oh-ih)/2:black",
            "-f", "image2pipe", "-vcodec", "ppm", "pipe:1",
        ], capture_output=True, check=False, timeout=30)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.decode("utf-8", errors="replace"))
        extracted = list(parse_ppm_stream(result.stdout))
        if not extracted:
            raise RuntimeError(f"No source frame at {timestamp} ms.")
        frame = extracted[0]
        rgb = np.frombuffer(frame.pixels, dtype=np.uint8).reshape((frame.height, frame.width, 3))
        panels.append(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    gutter = np.full((panels[0].shape[0], 4, 3), 12, dtype=np.uint8)
    storyboard = np.hstack([panels[0], gutter, panels[1], gutter, panels[2]])
    output_dir.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(os.fspath(output_dir / filename), storyboard, [cv2.IMWRITE_JPEG_QUALITY, 86]):
        raise RuntimeError("OpenCV could not write the storyboard image.")


def analyse_segment(
    input_path: Path,
    start_ms: int,
    duration_ms: int,
    sample_fps: float,
    output_dir: Path | None,
    storyboard_prefix: str,
    visual_start_ms: int | None = None,
) -> dict:
    if not input_path.is_file():
        raise FileNotFoundError(f"Video not found: {input_path}")
    start_ms = max(0, int(start_ms))
    duration_ms = max(500, min(int(duration_ms), MAX_DURATION_MS))
    sample_fps = max(0.5, min(float(sample_fps), 4.0))
    frames = decode_frames(input_path, start_ms, duration_ms, sample_fps)

    cv2, np = opencv_modules()
    enhanced = cv2 is not None and np is not None
    engine = OPENCV_ENGINE if enhanced else BASELINE_ENGINE
    step_ms = 1000.0 / sample_fps

    metrics_list = []
    previous = None
    for frame in frames:
        if enhanced:
            metrics, previous = opencv_metrics(frame, previous, cv2, np)
        else:
            metrics, previous = baseline_metrics(frame, previous["pixels"] if previous else None)
        metrics_list.append(metrics)

    observations = []
    storyboards = []
    last_event_ms = start_ms - 8_000
    last_storyboard_ms = start_ms - 3_000
    visual_start_ms = max(start_ms, int(visual_start_ms if visual_start_ms is not None else start_ms))
    last_visual_ms = None
    previous_motion = 0.0

    for index, metrics in enumerate(metrics_list):
        media_time_ms = start_ms + round(index * step_ms)
        visual_due = (enhanced and output_dir is not None
                      and media_time_ms >= visual_start_ms
                      and (last_visual_ms is None or media_time_ms - last_visual_ms >= 12_000))
        reason = None
        if index == 0:
            reason = "segment_start"
        elif metrics["sceneScore"] >= 0.34:
            reason = "scene_change"
        elif (
            metrics["motionScore"] >= 0.16
            and metrics["motionScore"] >= previous_motion * 1.18
            and media_time_ms - last_event_ms >= 1_500
        ):
            reason = "motion_peak"
        elif media_time_ms - last_event_ms >= 8_000:
            reason = "heartbeat"
        previous_motion = metrics["motionScore"]
        detected_event = reason is not None
        if visual_due and reason not in {"scene_change", "motion_peak"}:
            reason = "visual_heartbeat"
        if reason is None:
            continue

        observation = {
            "fromMs": media_time_ms,
            "toMs": media_time_ms + round(step_ms),
            "kind": reason,
            "sceneScore": metrics["sceneScore"],
            "motionScore": metrics["motionScore"],
            "metrics": metrics,
        }
        if (
            enhanced
            and output_dir is not None
            and (visual_due or (reason in {"scene_change", "motion_peak"}
                                and media_time_ms - last_storyboard_ms >= 2_500))
        ):
            filename = f"{storyboard_prefix}-{len(storyboards) + 1:04d}-{media_time_ms}.jpg"
            indices = select_storyboard_indices(metrics_list, index, step_ms, reason)
            panel_times_ms = [start_ms + round(i * step_ms) for i in indices]
            selected_metrics = metrics_list[indices[-1]]
            write_storyboard(input_path, panel_times_ms, output_dir, filename, cv2, np)
            frame_info = {
                "filename": filename,
                "mediaTimeMs": panel_times_ms[-1],
                "panelTimesMs": panel_times_ms,
                "frameReason": reason,
                "perceptualHash": selected_metrics.get("perceptualHash"),
                "averageRgb": selected_metrics.get("averageRgb"),
            }
            # Deliver the event only when every panel has been seen. Keep the
            # original detector timestamp for clients inspecting event timing.
            observation["eventTimeMs"] = media_time_ms
            observation["fromMs"] = panel_times_ms[-1]
            observation["toMs"] = min(start_ms + duration_ms, panel_times_ms[-1] + round(step_ms))
            observation["storyboard"] = frame_info
            storyboards.append(frame_info)
            # A fallback must not suppress a real event that arrives just after it.
            if reason in {"scene_change", "motion_peak"}:
                last_storyboard_ms = media_time_ms
            if panel_times_ms[-1] >= visual_start_ms:
                last_visual_ms = panel_times_ms[-1]

        observations.append(observation)
        if detected_event:
            last_event_ms = media_time_ms

    return {
        "ok": True,
        "protocolVersion": PROTOCOL_VERSION,
        "engine": engine,
        "startMs": start_ms,
        "durationMs": duration_ms,
        "sampleFps": sample_fps,
        "decodedFrameCount": len(frames),
        "observations": observations,
        "frames": storyboards,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Open Watch Cinema observation worker")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("health")
    analyse = subparsers.add_parser("analyze")
    analyse.add_argument("--input", required=True)
    analyse.add_argument("--start-ms", type=int, default=0)
    analyse.add_argument("--duration-ms", type=int, default=10_000)
    analyse.add_argument("--sample-fps", type=float, default=2.0)
    analyse.add_argument("--output-dir")
    analyse.add_argument("--storyboard-prefix", default="segment")
    analyse.add_argument("--visual-start-ms", type=int)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        payload = health_payload() if args.command == "health" else analyse_segment(
            Path(args.input),
            args.start_ms,
            args.duration_ms,
            args.sample_fps,
            Path(args.output_dir) if args.output_dir else None,
            args.storyboard_prefix,
            args.visual_start_ms,
        )
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
