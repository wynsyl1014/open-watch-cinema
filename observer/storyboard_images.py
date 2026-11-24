"""Image decoding, geometry, encoding and file I/O shared by storyboard writers."""
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable


@dataclass(frozen=True)
class PpmFrame:
    width: int
    height: int
    pixels: bytes


@dataclass
class StoryboardInset:
    pixels: object
    view: dict
    border: int
    separate: bool = False

    def protect_region(self, left, top, right, bottom):
        x, y, width, height = self.view["box"]
        padding = 1 + ((self.border + 1) // 2 if self.border > 1 else 0)
        if x - padding < right and x + width + padding > left and y - padding < bottom and y + height + padding > top:
            self.separate = True


@dataclass
class StoryboardPicture:
    pixels: object
    views: list
    insets: list[StoryboardInset] = field(default_factory=list)

    def content(self):
        for view in self.views:
            x, y, width, height = view["box"]
            yield self.pixels[y:y + height, x:x + width], view
        for inset in self.insets:
            yield inset.pixels, inset.view

    def rendered(self, cv2):
        views = []
        separate = []
        for view in self.views:
            views.append(view)
            for inset in self.insets:
                if inset.view["anchorTimeMs"] != view["mediaTimeMs"]:
                    continue
                x, y, width, height = inset.view["box"]
                if inset.separate:
                    separate.append((inset.pixels, [{**inset.view, "box": [0, 0, width, height]}]))
                    continue
                cv2.rectangle(self.pixels, (x - 1, y - 1), (x + width, y + height), (175, 191, 205), inset.border)
                self.pixels[y:y + height, x:x + width] = inset.pixels
                views.append(inset.view)
        yield self.pixels, views
        yield from separate


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


def fitted_size(image, max_width, max_height):
    h, w = image.shape[:2]
    ratio = min(max_width / w, max_height / h, 1)
    return max(1, round(w * ratio)), max(1, round(h * ratio))


def scaled_box(box, old_size, new_size):
    w,h = old_size
    nw,nh = new_size
    l,t,r,b = box
    x, y = min(nw-1, round(l*nw/w)), min(nh-1, round(t*nh/h))
    return x, y, max(x+1, round(r*nw/w)), max(y+1, round(b*nh/h))


def storyboard_sources(frames, times, review):
    """Keep the source for each candidate and any frames reviewed between candidates."""
    sources = dict(zip(times, frames))

    def remember(start, end):
        samples = review(start, end)
        if samples is None:
            return None
        tracked = []
        for time, frame in samples:
            if start < time < end:
                sources[time] = frame
                tracked.append((time, frame))
        return tracked

    return sources, remember if review is not None else None


def storyboard_view_key(kind, time, source_box=None):
    if kind == 'full':
        return kind, time
    if kind == 'crop' and source_box is not None:
        return kind, time, tuple(source_box)
    return None


def contextual_changes(records, start, sources, prepared_views):
    """Group consecutive crops and leave enough context around each local change."""
    changes = []
    crops = []
    while start < len(records) and records[start][3] is not None:
        index, time, frame, (left, top, right, bottom) = records[start]
        start += 1
        height, width = frame.shape[:2]
        crop_width = min(width, max(right - left, round(width * .17)))
        crop_height = min(height, max(bottom - top, round(height * .20)))
        x = min(width - crop_width, max(0, (left + right - crop_width) // 2))
        y = min(height - crop_height, max(0, (top + bottom - crop_height) // 2))
        box = x, y, x + crop_width, y + crop_height
        source = sources[time]
        source_height, source_width = source.shape[:2]
        l, t, r, b = scaled_box(box, (width, height), (source_width, source_height))
        source_box = [l / source_width, t / source_height, r / source_width, b / source_height]
        if storyboard_view_key('crop', time, source_box) not in prepared_views:
            changes.append((index, time, frame, box))
            crops.append((source[t:b, l:r], source_box))
    return changes, crops, start


def render_crop(change, crop, anchor_time, display_box, cv2):
    """Resize the same source crop for either profile and record its original bounds."""
    index, time, _, _ = change
    pixels, source_box = crop
    _, _, display_width, display_height = display_box
    interpolation = cv2.INTER_AREA if display_width <= pixels.shape[1] else cv2.INTER_CUBIC
    piece = cv2.resize(pixels, (display_width, display_height), interpolation=interpolation)
    view = dict(sourceIndex=index, mediaTimeMs=time, type='crop',
                box=list(display_box), anchorTimeMs=anchor_time, sourceBox=source_box)
    return piece, view


def write_image_bytes(file_path: Path, data: bytes) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = file_path.with_name(f".{file_path.name}.tmp-{os.getpid()}")
    try:
        temporary.write_bytes(data)
        os.replace(temporary, file_path)
    finally:
        temporary.unlink(missing_ok=True)


def encode_jpeg(pixels, quality: int, cv2) -> bytes:
    ok, encoded = cv2.imencode(".jpg", pixels, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("OpenCV could not encode the prepared image.")
    return encoded.tobytes()


def encode_reviewed_part(canvas, views, settings, cv2, *, fallback_heights=()):
    height = settings.storyboard_height
    heights = [height]
    if settings.storyboard_max_bytes is not None:
        heights.extend(h for h in fallback_heights if h < height)
    minimum = settings.min_storyboard_jpeg_quality or settings.storyboard_jpeg_quality
    qualities = list(range(settings.storyboard_jpeg_quality, minimum, -5)) + [minimum]
    for target in heights:
        picture, layout = canvas, views
        if target < height:
            h,w = canvas.shape[:2]
            size = max(1, round(w*target/height)), max(1, round(h*target/height))
            picture = cv2.resize(canvas, size, interpolation=cv2.INTER_AREA)
            layout = []
            for view in views:
                x,y,vw,vh = view["box"]
                l,t,r,b = scaled_box((x,y,x+vw,y+vh), (w,h), size)
                layout.append({**view, "box": [l,t,r-l,b-t]})
        for quality in qualities:
            encoded = encode_jpeg(picture, quality, cv2)
            if settings.storyboard_max_bytes is None or len(encoded) <= settings.storyboard_max_bytes:
                return encoded, {"views": layout, "width": picture.shape[1], "height": picture.shape[0],
                                 "bytes": len(encoded), "jpegQuality": quality, "requestedHeight": height,
                                 "budgetLimited": target < height or quality < settings.storyboard_jpeg_quality}
    raise ValueError("Storyboard part exceeds the image budget.")


def storyboard_canvas(panels: list, height: int, cv2, np, *, width: int, gutter_width: int):
    """Fit complete frames into equal-size cells in chronological order."""
    fitted = []
    for panel in panels:
        source_height, source_width = panel.shape[:2]
        ratio = min(width / source_width, height / source_height, 1.0)
        target_width = max(1, min(width, round(source_width * ratio)))
        target_height = max(1, min(height, round(source_height * ratio)))
        if (target_height, target_width) == (source_height, source_width):
            image = panel
        else:
            image = cv2.resize(panel, (target_width, target_height), interpolation=cv2.INTER_AREA)
        canvas = np.zeros((height, width, 3), dtype=np.uint8)
        left, top = (width - target_width) // 2, (height - target_height) // 2
        canvas[top:top + target_height, left:left + target_width] = image
        if fitted:
            fitted.append(np.full((height, gutter_width, 3), 12, dtype=np.uint8))
        fitted.append(canvas)
    return np.hstack(fitted)
