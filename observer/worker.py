#!/usr/bin/env python3
"""Open Watch Cinema visual observation worker."""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import Counter, deque
from dataclasses import dataclass
from pathlib import Path

from storyboard_images import (PpmFrame, StoryboardPicture, encode_reviewed_part,
                               storyboard_view_key, write_image_bytes)

from video_decode import DecodeBackend, SourceVideoDecoder, decode_frames

PROTOCOL_VERSION = 2
OPENCV_ENGINE = "opencv-observer-v1"
MODE_ASSET_VERSIONS = {"economy": 3, "balanced": 4, "full": 4}
MAX_DURATION_MS = 300_000
PROGRESS_PREFIX = "OWC_PROGRESS "
MODE_HEIGHTS = {
    "economy": (124,),
    "balanced": (268,),
    "full": (480, 720, 1080),
}


def emit_progress(phase: str, completed: int, total: int, media_time_ms: int | None = None) -> None:
    payload = {"phase": phase, "completed": int(completed), "total": int(total)}
    if media_time_ms is not None:
        payload["mediaTimeMs"] = int(media_time_ms)
    print(f"{PROGRESS_PREFIX}{json.dumps(payload, separators=(',', ':'))}", file=sys.stderr, flush=True)


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
        "opencvAvailable": cv2 is not None,
        "opencvVersion": str(cv2.__version__) if cv2 is not None else None,
        "opencvEngine": OPENCV_ENGINE if cv2 is not None else None,
        "pythonVersion": sys.version.split()[0],
        "ffmpegCommand": "ffmpeg",
    }


# ---- Image analysis and selection ----
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


def motion_direction(flow, magnitude, motion_mean: float, np) -> str:
    if motion_mean < 0.15:
        return "still"
    active = magnitude > 0.35
    weights = magnitude[active].astype(np.float64)
    net_x, net_y = (flow[active] * weights[:, None]).sum(axis=0)
    net_motion = math.hypot(net_x, net_y)
    active_motion = float(weights @ weights)
    # Keep the original speed weighting for the angle. Report that angle
    # only when at least half the weighted motion survives cancellation.
    if not math.isfinite(net_motion) or net_motion == 0 or net_motion < 0.5 * active_motion:
        return "still"
    angle = (math.degrees(math.atan2(net_y, net_x)) + 360.0) % 360.0
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
    motion_mean = motion_coverage = 0.0
    direction = "still"
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
        direction = motion_direction(flow, magnitude, motion_mean, np)

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
        "motionDirection": direction,
        "perceptualHash": perceptual_hash(gray, cv2, np),
        "sceneScore": round(scene_score, 4),
        "motionScore": round(motion_score, 4),
    }
    return metrics, {"gray": gray, "histogram": histogram, "edgeDensity": edge_density}


# ---- Prepared image configuration and generation ----
@dataclass(frozen=True)
class ImageSettings:
    """Explicit preparation choices for the current three storyboard modes."""

    mode: str
    storyboard_height: int
    storyboard_jpeg_quality: int
    asset_version: int
    storyboard_max_bytes: int | None = None
    min_storyboard_jpeg_quality: int | None = None

    @classmethod
    def from_mapping(cls, value: dict) -> ImageSettings:
        if not isinstance(value, dict):
            raise ValueError("imageSettings must be a JSON object.")
        required = {"mode", "assetVersion", "storyboardHeight", "storyboardJpegQuality"}
        optional = {"storyboardMaxBytes", "minStoryboardJpegQuality"}
        if required - value.keys() or value.keys() - required - optional:
            raise ValueError("imageSettings must specify the current mode, version, height and JPEG quality.")
        mode = value["mode"]
        if mode not in MODE_HEIGHTS:
            raise ValueError("Invalid storyboard mode.")
        if type(value["assetVersion"]) is not int or value["assetVersion"] != MODE_ASSET_VERSIONS[mode]:
            raise ValueError("Unsupported prepared-image assetVersion.")
        height = value["storyboardHeight"]
        if type(height) is not int or height not in MODE_HEIGHTS[mode]:
            raise ValueError("Invalid storyboard height for mode.")
        quality = value["storyboardJpegQuality"]
        if type(quality) is not int or not 1 <= quality <= 100:
            raise ValueError("storyboardJpegQuality must be between 1 and 100.")
        budget, minimum = value.get("storyboardMaxBytes"), value.get("minStoryboardJpegQuality")
        if budget is not None and (type(budget) is not int or budget <= 0):
            raise ValueError("storyboardMaxBytes must be a positive integer.")
        if minimum is not None and (type(minimum) is not int or not 1 <= minimum <= quality):
            raise ValueError("minStoryboardJpegQuality must be between 1 and storyboardJpegQuality.")
        if (budget is None) != (minimum is None):
            raise ValueError("storyboardMaxBytes and minStoryboardJpegQuality must be specified together.")
        return cls(mode, height, quality, value["assetVersion"], budget, minimum)

    def payload(self) -> dict:
        result = {
            "mode": self.mode,
            "assetVersion": self.asset_version,
            "storyboardHeight": self.storyboard_height,
            "storyboardJpegQuality": self.storyboard_jpeg_quality,
        }
        if self.storyboard_max_bytes is not None:
            result["storyboardMaxBytes"] = self.storyboard_max_bytes
        if self.min_storyboard_jpeg_quality is not None:
            result["minStoryboardJpegQuality"] = self.min_storyboard_jpeg_quality
        return result


@dataclass
class PendingPanorama:
    pixels: object
    view: dict
    picture: StoryboardPicture
    marks: object
    source: object

    def protect_region(self, bounds):
        """Keep the original location visible if a later crop lands under an inset."""
        x, y, _, _ = self.view["box"]
        left, top, right, bottom = bounds
        for inset in self.picture.insets:
            inset.protect_region(x + left, y + top, x + right, y + bottom)


class StoryboardComposer:
    """Decode source frames for the selected film profile and write its finished images."""

    def __init__(self, input_path: Path, output_dir: Path, settings: ImageSettings, cv2, np, *,
                 previous_views=(), backend=None, decode_end_ms=None):
        self.input_path, self.output_dir, self.settings = input_path, output_dir, settings
        self.cv2, self.np = cv2, np
        self.decoder = SourceVideoDecoder(input_path, cv2, np, backend=backend or DecodeBackend.for_storyboards(),
                                          end_ms=decode_end_ms)
        self.source = self.decoder.source
        self.prepared_views = {
            key for view in previous_views
            if (key := storyboard_view_key(view["type"], view["mediaTimeMs"], view.get("sourceBox"))) is not None
        }
        self.face_detector = None
        if settings.mode in ("balanced", "full"):
            from storyboard_insets import load_face_detector
            self.face_detector = load_face_detector()

    def extract_images(self, timestamp: int, end_ms: int | None = None):
        return self.decoder.extract_images(timestamp, end_ms, review_mode=self.settings.mode)

    def transient_frame(self, timestamp: int):
        return self.decoder.transient_frame(timestamp)

    def _storyboard_pictures(self, panel_times_ms, prepared_views, scene, frame_reason):
        mode = self.settings.mode
        if mode == "balanced":
            from balanced_storyboard import balanced_pictures
            return balanced_pictures(self.transient_frame, panel_times_ms, self.extract_images, self.face_detector,
                                     prepared_views=prepared_views, scene=scene, frame_reason=frame_reason)
        panels = [self.transient_frame(t) for t in panel_times_ms]
        if mode == "full":
            from full_storyboard import full_pictures
            return full_pictures(panels, panel_times_ms, self.extract_images, self.face_detector,
                                 self.settings.storyboard_height, prepared_views=prepared_views,
                                 scene=scene, frame_reason=frame_reason)
        from economy_storyboard import economy_images
        return [StoryboardPicture(pixels, views) for pixels, views in economy_images(
            panels, panel_times_ms, self.extract_images, self.settings, self.cv2, self.np,
            prepared_views=prepared_views)]

    def _write_pictures(self, filename, panel_times_ms, pictures):
        fallback_heights = ()
        if self.settings.mode == "full":
            from full_storyboard import FALLBACK_HEIGHTS
            fallback_heights = FALLBACK_HEIGHTS
        parts = []
        if self.settings.mode == "balanced":
            from balanced_storyboard import balanced_parts
            rendered = balanced_parts(pictures)
        else:
            rendered = (part for picture in pictures for part in picture.rendered(self.cv2))
        for index, (canvas, views) in enumerate(rendered):
            encoded, image = encode_reviewed_part(canvas, views, self.settings, self.cv2,
                                                  fallback_heights=fallback_heights)
            path = Path(filename)
            name = filename if index == 0 else path.with_name(f"{path.stem}-part-{index + 1}{path.suffix}").as_posix()
            write_image_bytes(self.output_dir / name, encoded)
            parts.append({"filename": name, "image": image, "mediaTimeMs": max(v["mediaTimeMs"] for v in views)})
        return {"parts": parts, "panels": [{"mediaTimeMs": t} for t in panel_times_ms],
                **({"image": parts[0]["image"]} if parts else {})}

    def write_storyboards(self, items, *, on_written=None):
        if not items:
            return []
        from storyboard_marks import crop_bounds, crop_region, mark_crop_pair
        from storyboard_selection import SCENE_REFRESH_MS, PreparedScene

        def group_time(item):
            times = item["panelTimesMs"]
            if (not 1 <= len(times) <= 3 or any(type(time) is not int or time < 0 for time in times)
                    or times != sorted(times)):
                raise ValueError("A storyboard requires one to three timestamps in chronological order.")
            return times[-1]

        scene = PreparedScene() if self.settings.mode != "economy" else None
        batch = sorted(enumerate(items), key=lambda pair: group_time(pair[1]))
        self.decoder.plan_frames(time for _, item in batch for time in item["panelTimesMs"])
        output = [None] * len(items)
        pending = deque()
        panoramas = {}
        known = set(self.prepared_views)
        counts = Counter()
        for offset, (item_index, item) in enumerate(batch):
            filename = item.get("filename")
            if not filename or Path(filename).is_absolute() or ".." in Path(filename).parts:
                raise ValueError("Invalid storyboard output path.")
            times = item["panelTimesMs"]
            if scene is not None and scene.anchor is not None and times[-1] - scene.anchor[0] > SCENE_REFRESH_MS:
                scene = PreparedScene()
            pictures = self._storyboard_pictures(times, known, scene, item.get("frameReason"))
            full_times = []
            if scene is not None:
                # Register the panorama before processing this group's embedded or standalone details.
                for picture in pictures:
                    for pixels, view in picture.content():
                        if view["type"] == "full":
                            time = view["mediaTimeMs"]
                            full_times.append(time)
                            _, _, width, height = view["box"]
                            panoramas[time] = PendingPanorama(
                                pixels, view, picture, self.np.zeros((height, width), dtype=bool), pixels.copy())
            for picture in pictures:
                for pixels, view in picture.content():
                    source_box = view.get("sourceBox")
                    key = storyboard_view_key(view["type"], view["mediaTimeMs"], source_box)
                    if key is not None:
                        known.add(key)
                    if view["type"] != "crop":
                        continue
                    time = view["anchorTimeMs"]
                    anchor = panoramas[time]
                    anchor.protect_region(crop_bounds(anchor.source, source_box))
                    mark_crop_pair(crop_region(anchor.source, source_box), pixels,
                                   crop_region(anchor.pixels, source_box), counts[time], anchor.source.shape[0],
                                   crop_region(anchor.marks, source_box))
                    counts[time] += 1
            pending.append((item_index, filename, times, pictures, full_times))
            while pending:
                if (offset + 1 < len(batch) and scene is not None and scene.anchor is not None
                        and scene.anchor[0] in pending[0][4]):
                    break
                item_index, filename, times, pictures, full_times = pending.popleft()
                output[item_index] = self._write_pictures(filename, times, pictures)
                for time in full_times:
                    panoramas.pop(time)
                    counts.pop(time, None)
                if on_written is not None:
                    on_written(item_index, times[-1])
        self.prepared_views = known
        return output


# ---- Internal processing results (no MCP or JSON transport types) ----
@dataclass
class FrameResult:
    filename: str
    panel_times_ms: list[int]
    reason: str
    selected_metrics: dict
    assets: dict


@dataclass
class ObservationResult:
    from_ms: int
    to_ms: int
    reason: str
    metrics: dict
    storyboard: FrameResult | None = None


@dataclass
class SegmentResult:
    engine: str
    start_ms: int
    duration_ms: int
    sample_fps: float
    decoded_frame_count: int
    observations: list[ObservationResult]
    frames: list[FrameResult]
    settings: ImageSettings | None
    source_video: dict | None


# ---- Processing orchestration ----
def calculate_metrics(frames, cv2, np, *, on_progress=None):
    metrics_list = []
    previous = None
    total = len(frames)
    step = max(1, min(24, total // 10 if total >= 10 else 1))
    for index, frame in enumerate(frames):
        metrics, previous = opencv_metrics(frame, previous, cv2, np)
        metrics_list.append(metrics)
        if on_progress is not None and ((index + 1) % step == 0 or index + 1 == total):
            on_progress("metrics", index + 1, total, None)
    return metrics_list


def plan_events(metrics_list, start_ms, duration_ms, step_ms, visual_start_ms, storyboard_prefix,
                *, render_images, visual_end_ms=None):
    """Choose events and storyboard times without creating assets."""
    if render_images:
        from storyboard_selection import select_storyboard_indices

    observations = []
    plans = []
    segment_end_ms = start_ms + duration_ms
    last_event_ms = start_ms - 8_000
    last_storyboard_ms = start_ms - 3_000
    visual_start_ms = max(start_ms, int(visual_start_ms if visual_start_ms is not None else start_ms))
    visual_end_ms = min(segment_end_ms, visual_end_ms if visual_end_ms is not None else segment_end_ms)
    last_visual_ms = None
    previous_motion = 0.0

    for index, metrics in enumerate(metrics_list):
        media_time_ms = start_ms + round(index * step_ms)
        visual_due = (render_images
                      and media_time_ms >= visual_start_ms
                      and (last_visual_ms is None or media_time_ms - last_visual_ms >= 12_000))
        reason = None
        if metrics["sceneScore"] >= 0.34:
            reason = "scene_change"
        elif (
            (
                metrics["motionScore"] >= 0.16
                and metrics["motionScore"] >= previous_motion * 1.18
                and media_time_ms - last_event_ms >= 1_500
            )
            or (
                metrics["motionScore"] >= 0.85
                and media_time_ms - last_event_ms >= 3_000
            )
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

        wants_storyboard = (
            render_images
            and (visual_due or (reason in {"scene_change", "motion_peak"}
                                and media_time_ms - last_storyboard_ms >= 2_500))
        )
        if wants_storyboard:
            indices = select_storyboard_indices(metrics_list, index, step_ms, reason)
            panel_times_ms = [start_ms + round(i * step_ms) for i in indices]
            from_ms = panel_times_ms[-1]
            # A fallback must not suppress a real event that arrives just after it.
            if reason in {"scene_change", "motion_peak"}:
                last_storyboard_ms = media_time_ms
            if visual_start_ms <= from_ms < visual_end_ms:
                to_ms = min(segment_end_ms, from_ms + round(step_ms))
                observation = ObservationResult(from_ms, to_ms, reason, metrics)
                observations.append(observation)
                plans.append((observation, panel_times_ms, metrics_list[indices[-1]]))
                last_visual_ms = from_ms if last_visual_ms is None else max(last_visual_ms, from_ms)
        elif visual_start_ms <= media_time_ms < visual_end_ms:
            to_ms = min(segment_end_ms, media_time_ms + round(step_ms))
            observations.append(ObservationResult(media_time_ms, to_ms, reason, metrics))

        if detected_event:
            last_event_ms = media_time_ms

    observations.sort(key=lambda item: item.from_ms)
    plans.sort(key=lambda plan: plan[0].from_ms)
    numbered_plans = [
        (observation, panel_times_ms, f"{storyboard_prefix}-{order:04d}-{observation.from_ms}.jpg", selected_metrics)
        for order, (observation, panel_times_ms, selected_metrics) in enumerate(plans, start=1)
    ]
    return observations, numbered_plans


def process_events(metrics_list, start_ms, duration_ms, step_ms, visual_start_ms,
                   storyboard_prefix, composer, *, visual_end_ms=None, on_progress=None):
    observations, plans = plan_events(metrics_list, start_ms, duration_ms, step_ms, visual_start_ms,
                                      storyboard_prefix, render_images=composer is not None,
                                      visual_end_ms=visual_end_ms)
    storyboards = []
    if composer is None:
        return observations, storyboards
    items = [{"panelTimesMs": times, "filename": filename, "frameReason": observation.reason}
             for observation, times, filename, _ in plans]

    def report_written(_, time):
        if on_progress is not None:
            elapsed = max(0, min(duration_ms, time - start_ms))
            on_progress("storyboards", elapsed, max(1, duration_ms), time)

    assets_by_group = composer.write_storyboards(items, on_written=report_written)
    for (observation, panel_times_ms, filename, metrics), assets in zip(plans, assets_by_group):
        frame = FrameResult(filename, panel_times_ms, observation.reason, metrics, assets)
        observation.storyboard = frame
        storyboards.append(frame)
    if on_progress is not None:
        on_progress("storyboards", max(1, duration_ms), max(1, duration_ms), start_ms + duration_ms)
    return observations, storyboards


def process_segment(
    input_path: Path,
    start_ms: int,
    duration_ms: int,
    sample_fps: float,
    output_dir: Path | None,
    storyboard_prefix: str,
    visual_start_ms: int | None = None,
    image_settings: dict | None = None,
    *,
    visual_end_ms: int | None = None,
    decode_end_ms: int | None = None,
    previous_views=(),
    on_progress=None,
) -> SegmentResult:
    if not input_path.is_file():
        raise FileNotFoundError(f"Video not found: {input_path}")
    cv2, np = opencv_modules()
    if cv2 is None or np is None:
        raise RuntimeError("Visual analysis requires OpenCV and NumPy in the observer Python environment.")
    if output_dir is not None and image_settings is None:
        raise ValueError("Prepared storyboard images require explicit imageSettings.")
    if image_settings is not None and output_dir is None:
        raise ValueError("Prepared storyboard images require an output directory.")
    settings = ImageSettings.from_mapping(image_settings) if image_settings is not None else None
    backend = DecodeBackend.for_storyboards()
    composer = StoryboardComposer(input_path, output_dir, settings, cv2, np,
                                  previous_views=previous_views, backend=backend,
                                  decode_end_ms=decode_end_ms) if settings else None
    start_ms = max(0, int(start_ms))
    duration_ms = max(500 if decode_end_ms is None else 1, min(int(duration_ms), MAX_DURATION_MS))
    sample_fps = max(0.5, min(float(sample_fps), 4.0))
    decode_options = {"video_stream_index": composer.source["streamIndex"]} if composer else {}
    decode_options["backend"] = backend
    step_ms = 1000.0 / sample_fps
    if decode_end_ms is not None and duration_ms < step_ms:
        decode_options["single_frame"] = True
    frames = decode_frames(input_path, start_ms, duration_ms, sample_fps, **decode_options)

    metrics_list = calculate_metrics(frames, cv2, np, on_progress=on_progress)
    observations, storyboards = process_events(
        metrics_list, start_ms, duration_ms, step_ms, visual_start_ms,
        storyboard_prefix, composer, visual_end_ms=visual_end_ms,
        on_progress=on_progress,
    )
    return SegmentResult(OPENCV_ENGINE, start_ms, duration_ms, sample_fps, len(frames),
                         observations, storyboards, settings,
                         dict(composer.source) if composer is not None else None)


# ---- Public worker result mapping: no decoding, selection or file writes ----
def frame_payload(frame: FrameResult) -> dict:
    result = {
        "filename": frame.filename,
        "mediaTimeMs": frame.panel_times_ms[-1],
        "panelTimesMs": list(frame.panel_times_ms),
        "frameReason": frame.reason,
        "perceptualHash": frame.selected_metrics.get("perceptualHash"),
        "averageRgb": frame.selected_metrics.get("averageRgb"),
    }
    if frame.assets is not None:
        result.update(frame.assets)
        if frame.assets.get("parts") == []:
            result.pop("filename", None)
            result["groupFilename"] = frame.filename
    return result


def observation_payload(observation: ObservationResult) -> dict:
    result = {
        "fromMs": observation.from_ms, "toMs": observation.to_ms,
        "kind": observation.reason, "sceneScore": observation.metrics["sceneScore"],
        "motionScore": observation.metrics["motionScore"], "metrics": observation.metrics,
    }
    if observation.storyboard is not None:
        result["storyboard"] = frame_payload(observation.storyboard)
    return result


def segment_payload(segment: SegmentResult) -> dict:
    result = {
        "ok": True, "protocolVersion": PROTOCOL_VERSION, "engine": segment.engine,
        "startMs": segment.start_ms, "durationMs": segment.duration_ms,
        "sampleFps": segment.sample_fps, "decodedFrameCount": segment.decoded_frame_count,
        "observations": [observation_payload(item) for item in segment.observations],
        "frames": [frame_payload(item) for item in segment.frames],
    }
    if segment.settings is not None:
        result["visualAssetProfile"] = segment.settings.payload()
        result["sourceVideo"] = segment.source_video
    return result


def analyse_segment(input_path: Path, start_ms: int, duration_ms: int, sample_fps: float,
                    output_dir: Path | None, storyboard_prefix: str,
                    visual_start_ms: int | None = None, image_settings: dict | None = None,
                    *, visual_end_ms: int | None = None, decode_end_ms: int | None = None,
                    previous_views=(), on_progress=None) -> dict:
    """Stable backend-facing API. The processing core returns internal records."""
    return segment_payload(process_segment(input_path, start_ms, duration_ms, sample_fps,
                                           output_dir, storyboard_prefix, visual_start_ms,
                                           image_settings, visual_end_ms=visual_end_ms,
                                           previous_views=previous_views, decode_end_ms=decode_end_ms,
                                           on_progress=on_progress))


# ---- CLI and JSON transport ----
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Open Watch Cinema observation worker")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("health")
    source_batch = subparsers.add_parser("compose-source-batch")
    source_batch.add_argument("--request")
    analyse = subparsers.add_parser("analyze")
    analyse.add_argument("--input", required=True)
    analyse.add_argument("--start-ms", type=int, default=0)
    analyse.add_argument("--duration-ms", type=int, default=10_000)
    analyse.add_argument("--sample-fps", type=float, default=2.0)
    analyse.add_argument("--output-dir")
    analyse.add_argument("--storyboard-prefix", default="segment")
    analyse.add_argument("--visual-start-ms", type=int)
    analyse.add_argument("--visual-end-ms", type=int)
    analyse.add_argument("--decode-end-ms", type=int)
    analyse.add_argument("--previous-views-stdin", action="store_true")
    analyse.add_argument("--image-settings-json", help="Explicit prepared-image settings required when rendering images.")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "health":
            payload = health_payload()
        elif args.command == "compose-source-batch":
            cv2, np = opencv_modules()
            if cv2 is None or np is None:
                raise RuntimeError("Visual composition requires OpenCV and NumPy.")
            request = json.loads(Path(args.request).read_text(encoding="utf-8")) if args.request else json.load(sys.stdin)
            composer = StoryboardComposer(Path(request["input"]), Path(request["outputDir"]),
                                          ImageSettings.from_mapping(request["settings"]), cv2, np,
                                          previous_views=request.get("previousViews", ()),
                                          decode_end_ms=request.get("decodeEndMs"))
            items = request["items"]
            total = len(items)
            emit_progress("compose", 0, total)
            count = 0

            def report_written(_, time):
                nonlocal count
                count += 1
                emit_progress("compose", count, total, time)

            composed = composer.write_storyboards(items, on_written=report_written)
            payload = {"ok": True, "items": composed}
        else:
            payload = analyse_segment(
                Path(args.input),
                args.start_ms,
                args.duration_ms,
                args.sample_fps,
                Path(args.output_dir) if args.output_dir else None,
                args.storyboard_prefix,
                args.visual_start_ms,
                json.loads(args.image_settings_json) if args.image_settings_json is not None else None,
                visual_end_ms=args.visual_end_ms,
                decode_end_ms=args.decode_end_ms,
                previous_views=json.load(sys.stdin) if args.previous_views_stdin else (),
                on_progress=emit_progress,
            )
        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
