"""Mark the matching region of a panorama and its detail image."""
import cv2
import numpy as np


COLORS = (
    (145, 215, 255), (255, 225, 115), (155, 245, 157), (235, 175, 255),
    (155, 155, 255), (240, 230, 160), (110, 185, 250), (255, 240, 235),
)
OUTLINE = (45, 43, 37)


def crop_bounds(frame, source_box):
    height, width = frame.shape[:2]
    x, y, right, bottom = (round(value * limit)
                            for value, limit in zip(source_box, (width, height, width, height)))
    x, y = min(x, width - 1), min(y, height - 1)
    return x, y, max(x + 1, right), max(y + 1, bottom)


def crop_region(frame, source_box):
    left, top, right, bottom = crop_bounds(frame, source_box)
    return frame[top:bottom, left:right]


def _corner_shape(width, height, corner, margin, arm):
    right, lower = corner
    x = width - margin - 1 if right else margin
    y = height - margin - 1 if lower else margin
    return np.array([(x + (-arm if right else arm), y), (x, y),
                     (x, y + (-arm if lower else arm))], dtype=np.int32)


def _placement(region, protection, corners, arm, margin, stroke, offsets=(0, 1, 3)):
    height, width = region.shape[:2]
    best = None
    for offset in offsets:
        inset = margin + offset
        if inset + arm >= min(height, width) - stroke:
            continue
        lines = [_corner_shape(width, height, corner, inset, arm) for corner in corners]
        mask = np.zeros((height, width), np.uint8)
        cv2.polylines(mask, lines, False, 1, stroke)
        score = int(protection[mask != 0].sum())
        if best is None or score < best[0]:
            best = (score, lines)
            if score == 0:
                break
    return best


def _paint(image, lines, color, stroke, line_width, occupied=None):
    if occupied is None:
        cv2.polylines(image, lines, False, OUTLINE, stroke)
        cv2.polylines(image, lines, False, color, line_width)
        return
    border = np.zeros(occupied.shape, np.uint8)
    foreground = np.zeros_like(border)
    cv2.polylines(border, lines, False, 1, stroke)
    cv2.polylines(foreground, lines, False, 1, line_width)
    free = ~occupied
    image[(border != 0) & free] = OUTLINE
    image[(foreground != 0) & free] = color
    occupied |= border != 0


def mark_crop_pair(source, detail, anchor_region, index, panorama_height, occupied=None):
    """Choose the same corner pattern using both clean endpoints before painting."""
    height, width = source.shape[:2]
    detail_height, detail_width = detail.shape[:2]
    minimum_dimension = min(height, width, detail_height, detail_width)
    color = COLORS[index % len(COLORS)]
    right = index % 2 == 0
    if minimum_dimension < 5:
        # Even a tiny source can carry a matched colored corner.
        for image, reserved in ((anchor_region, occupied), (detail, None)):
            if image is not None:
                x = image.shape[1] - 1 if right else 0
                if reserved is None or not reserved[0, x]:
                    image[0, x] = color
                    if reserved is not None:
                        reserved[0, x] = True
        return
    scale = max(1., panorama_height / 268)
    arm = min(round(11 * scale), (minimum_dimension - 2) // 3)
    margin = min(round(5 * scale), max(1, minimum_dimension // 5))
    stroke = min(2 * round(scale) + 1, max(1, minimum_dimension // 5))
    line_width = max(1, stroke // 3)
    comparable = cv2.resize(detail, (width, height), interpolation=cv2.INTER_AREA)
    changed = (cv2.absdiff(source, comparable).max(axis=2) >= 25).astype(np.uint8)
    detail_changes = cv2.resize(changed, (detail_width, detail_height), interpolation=cv2.INTER_NEAREST)
    dilate = np.ones((3, 3), np.uint8)
    source_protection = cv2.dilate(cv2.Canny(source, 28, 72), dilate) // 255 + 8 * cv2.dilate(changed, dilate)
    detail_protection = cv2.dilate(cv2.Canny(detail, 28, 72), dilate) // 255 + 8 * cv2.dilate(detail_changes, dilate)
    choices = [((side, False), (side, True)) for side in (right, not right)]
    choices += [((side, lower),) for side in (right, not right) for lower in (False, True)]
    best = None
    for corners in choices:
        source_place = _placement(source, source_protection, corners, arm, margin, stroke)
        detail_place = _placement(detail, detail_protection, corners, arm, margin, stroke)
        if source_place is None or detail_place is None:
            continue
        score = source_place[0] + detail_place[0]
        if best is None or score < best[0]:
            best = (score, corners, source_place[1], detail_place[1])
        if score == 0:
            break
    if best is None:
        return
    _, corners, source_lines, detail_lines = best
    if anchor_region is not None:
        if occupied is not None and occupied.any():
            # Keep the same orientation and color on both sides. Move the source
            # strokes inward if this corner already carries another pair.
            reserved = source_protection + 100 * occupied.astype(np.uint8)
            source_lines = _placement(source, reserved, corners, arm, margin, stroke,
                                      offsets=(0, 1, 3, 5, 8, 12, 16, 20))[1]
        _paint(anchor_region, source_lines, color, stroke, line_width, occupied)
    _paint(detail, detail_lines, color, stroke, line_width)
