"""FFmpeg source decoding for local visual preparation."""
from __future__ import annotations

from collections import OrderedDict
from fractions import Fraction
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from storyboard_images import PpmFrame, parse_ppm_stream

WIDTH = 192
HEIGHT = 108
SOURCE_MAX_HEIGHT = 1080


class DecodeFailure(RuntimeError):
    """An ordinary FFmpeg command error, eligible for a single-frame retry."""


class DecodeBackend:
    """Share the hardware decision across a single preparation worker."""

    def __init__(self, videotoolbox=False):
        self.videotoolbox = videotoolbox

    @classmethod
    def for_storyboards(cls):
        return cls(videotoolbox=sys.platform == "darwin")

    def run(self, args, *, timeout=None, loglevel="error"):
        command = ["ffmpeg", "-hide_banner", "-nostats", "-loglevel", loglevel]
        options = ["-hwaccel", "videotoolbox"] if self.videotoolbox else []
        result = subprocess.run(command + options + args, capture_output=True, timeout=timeout)
        # FFmpeg returns 255 for a handled interrupt. A signal or timeout must
        # reach the caller immediately, even during the first hardware decode.
        if options and self._ordinary_error(result.returncode):
            result = subprocess.run(command + args, capture_output=True, timeout=timeout)
            if result.returncode == 0:
                self.videotoolbox = False
        if result.returncode:
            error_type = DecodeFailure if self._ordinary_error(result.returncode) else RuntimeError
            detail = result.stderr.decode("utf-8", errors="replace").strip()
            raise error_type(detail or f"FFmpeg exited with code {result.returncode}.")
        return result

    @staticmethod
    def _ordinary_error(code):
        # Negative POSIX signals, shell interrupt statuses and Windows NTSTATUS
        # are distinct from FFmpeg's byte-sized AVERROR exit statuses.
        return 0 < code < 255 and code not in (129, 130, 131, 137, 143)


# ---- Video decoding ----
def decode_frames(input_path: Path, start_ms: int, duration_ms: int, sample_fps: float,
                  video_stream_index: int | None = None, *, backend=None, single_frame=False) -> list[PpmFrame]:
    filters = (
        ("" if single_frame else f"fps={sample_fps},") +
        f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=decrease:flags=area,"
        f"pad={WIDTH}:{HEIGHT}:(ow-iw)/2:(oh-ih)/2:black"
    )
    command = [
        "-ss", f"{start_ms / 1000:.3f}", "-t", f"{duration_ms / 1000:.3f}",
        "-i", os.fspath(input_path),
        *(["-map", f"0:{video_stream_index}"] if video_stream_index is not None else []),
        "-an", "-vf", filters,
        *(["-frames:v", "1"] if single_frame else []),
        "-f", "image2pipe", "-vcodec", "ppm", "-pix_fmt", "rgb24", "pipe:1",
    ]
    result = (backend or DecodeBackend.for_storyboards()).run(command)
    return list(parse_ppm_stream(result.stdout))


class SourceVideoDecoder:
    """Probe and decode square-pixel frames directly from the local source film."""

    def __init__(self, input_path: Path, cv2, np, *, max_height: int = SOURCE_MAX_HEIGHT, backend=None, end_ms=None):
        self.input_path = input_path
        self.cv2, self.np = cv2, np
        self.max_height = max_height
        self.backend = backend or DecodeBackend()
        self.end_ms = end_ms
        self.recent_pixels = OrderedDict()
        self.batch_groups = {}
        self.batch_pixels = {}
        probe = subprocess.run([
            "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_streams",
            "-show_entries", "stream:stream_tags=rotate:stream_side_data=rotation:format=format_name",
            "-of", "json", os.fspath(input_path),
        ], capture_output=True, check=False, timeout=30)
        if probe.returncode != 0:
            raise RuntimeError(probe.stderr.decode("utf-8", errors="replace"))
        metadata = json.loads(probe.stdout)
        formats = set(metadata.get("format", {}).get("format_name", "").split(","))
        # Transport streams can seek to a different first decodable GOP for
        # each target. Keep individual seeks for unverified demuxers.
        self.batch_supported = bool(formats & {"mov", "matroska", "webm"})
        streams = metadata.get("streams", [])
        if not streams:
            raise ValueError("No source video stream is available for image preparation.")
        stream = streams[0]
        try:
            self.time_base = Fraction(stream.get("time_base") or "0")
        except (ValueError, ZeroDivisionError):
            self.time_base = Fraction(0)
        self.source = {
            "streamIndex": int(stream["index"]),
            "width": int(stream["width"]),
            "height": int(stream["height"]),
            "sampleAspectRatio": stream.get("sample_aspect_ratio", "1:1"),
        }
        if self.source["width"] <= 0 or self.source["height"] <= 0:
            raise ValueError("Source video dimensions must be positive.")
        rotation = next((item["rotation"] for item in stream.get("side_data_list", [])
                         if "rotation" in item), stream.get("tags", {}).get("rotate", 0))
        self.source["rotation"] = float(rotation)

    def _source_filter(self):
        max_height = self.max_height
        max_width = round(max_height * 16 / 9)
        # Square-pixel conversion precedes fitting. The second scale never enlarges
        # the display-sized source, and FFmpeg keeps its default autorotation.
        return (
            "scale=w='trunc(iw*if(gt(sar,0),sar,1)+0.5)':h=ih,setsar=1,"
            f"scale=w='min(iw,{max_width})':h='min(ih,{max_height})':"
            "force_original_aspect_ratio=decrease:flags=lanczos"
        )

    def extract_images(self, timestamp: int, end_ms: int | None = None, *, review_mode: str | None = None):
        filters = self._source_filter()
        review = end_ms is not None
        count = (end_ms - timestamp) // 125 + 1 if review else 1
        if review:
            filters = f"fps=8:start_time=0:round=up,{filters}"
            if review_mode == "economy":
                from storyboard_selection import scene_frame
                height, width = scene_frame(self.transient_frame(timestamp)).shape[:2]
                filters += f",scale={width}:{height}:flags=area"
        result = self._read(timestamp, filters, count)
        if not result.stdout:
            raise RuntimeError(f"No source frame at {timestamp} ms.")
        for index, frame in enumerate(parse_ppm_stream(result.stdout)):
            yield timestamp + index * 125, self._pixels(frame)

    def _pixels(self, frame):
        rgb = self.np.frombuffer(frame.pixels, dtype=self.np.uint8).reshape(frame.height, frame.width, 3)
        return self.cv2.cvtColor(rgb, self.cv2.COLOR_RGB2BGR)

    def _read(self, start, filters, count, *, window_ms=None, loglevel="error"):
        duration_ms = window_ms
        if self.end_ms is not None:
            remaining = self.end_ms - start
            duration_ms = remaining if window_ms is None else min(remaining, window_ms)
        return self.backend.run([
            "-ss", f"{start / 1000:.3f}",
            *(["-t", f"{duration_ms / 1000:.3f}"] if duration_ms is not None else []),
            "-i", os.fspath(self.input_path),
            "-map", f"0:{self.source['streamIndex']}", "-an", "-frames:v", str(count),
            "-vf", filters, *(["-fps_mode", "passthrough"] if window_ms is not None else []),
            "-f", "image2pipe", "-vcodec", "ppm", "-pix_fmt", "rgb24", "pipe:1",
        ], timeout=30, loglevel=loglevel)

    def extract_frame(self, timestamp: int):
        return next(self.extract_images(timestamp))[1]

    def transient_frame(self, timestamp: int):
        pixels = self.recent_pixels.pop(timestamp, None)
        if pixels is None:
            pixels = self.batch_pixels.pop(timestamp, None)
        if pixels is None:
            group = self.batch_groups.pop(timestamp, ())
            if group:
                for time in group:
                    self.batch_groups.pop(time, None)
                self.batch_pixels.clear()
                try:
                    self.batch_pixels = self._nearby_frames(group)
                except (DecodeFailure, ValueError):
                    # An unsupported filter/option or malformed timestamp/image
                    # pair can always use the established individual seek.
                    pass
                pixels = self.batch_pixels.pop(timestamp, None)
        if pixels is None:
            pixels = self.extract_frame(timestamp)
        self.recent_pixels[timestamp] = pixels
        if len(self.recent_pixels) > 6:
            self.recent_pixels.popitem(last=False)
        return pixels

    def plan_frames(self, times):
        """Only the current group has decoded pixels. Future groups hold timestamps."""
        self.batch_groups.clear()
        self.batch_pixels.clear()
        group = []
        for time in sorted(set(times)):
            if group and (len(group) == 16 or time - group[0] > 8000):
                self._register_group(group)
                group = []
            group.append(time)
        self._register_group(group)

    def _register_group(self, group):
        if len(group) > 1 and self.batch_supported and self.time_base > 0:
            # A fractional difference in the stream clock can round differently
            # on individual input seeks. Keep the original seek for such targets.
            aligned = [time for time in group if
                       (Fraction(time - group[0], 1000) / self.time_base).denominator == 1]
            if len(aligned) > 1:
                for time in aligned:
                    self.batch_groups[time] = aligned

    def _nearby_frames(self, times):
        start = times[0]
        offsets = [int(Fraction(time - start, 1000) / self.time_base) for time in times]
        crossings = "+".join(f"gte(pts,{tick})*if(isnan(prev_pts),1,lt(prev_pts,{tick}))"
                             for tick in offsets)
        filters = f"select='{crossings}',showinfo=checksum=0,{self._source_filter()}"
        result = self._read(start, filters, len(times), loglevel="info", window_ms=times[-1] - start + 1000)
        clocks = re.findall(rb"config in time_base: (\d+)/(\d+)", result.stderr)
        if len(clocks) != 1 or tuple(map(int, clocks[0])) != (self.time_base.numerator, self.time_base.denominator):
            return {}
        stamps = [int(match) for match in re.findall(rb"\bn:\s*\d+\s+pts:\s*(-?\d+)\s", result.stderr)]
        if not stamps or stamps[0] < 0 or any(b <= a for a, b in zip(stamps, stamps[1:])):
            return {}
        frames = iter(parse_ppm_stream(result.stdout))
        pending = 0
        images = {}
        for stamp in stamps:
            frame = next(frames, None)
            if frame is None or pending == len(times) or stamp < offsets[pending]:
                return {}
            pixels = self._pixels(frame)
            while pending < len(times) and offsets[pending] <= stamp:
                images[times[pending]] = pixels
                pending += 1
        return images if next(frames, None) is None else {}
