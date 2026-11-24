"""Find inset positions that avoid faces, text and action in the anchor frame."""
import os
from pathlib import Path

import cv2
import numpy as np


def load_face_detector():
    data_root = Path(os.environ.get("LOCAL_DATA_ROOT", Path(__file__).resolve().parents[1] / "local-data"))
    model = data_root / "模型/角色识别/face_detection_yunet_2023mar.onnx"
    if model.is_file():
        return cv2.FaceDetectorYN.create(str(model), "", (320, 320), 0.7)
    return None


def text_regions(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 35, 90)
    _, _, components, _ = cv2.connectedComponentsWithStats(edges)
    strokes = np.zeros_like(gray)
    for x, y, w, h, area in components[1:]:
        if 2 <= w <= 25 and 3 <= h <= 24 and area >= 4:
            strokes[y:y + h, x:x + w] = 255
    joined = cv2.dilate(strokes, np.ones((3, 9), np.uint8))
    _, _, groups, _ = cv2.connectedComponentsWithStats(joined)
    text = np.zeros_like(gray)
    for x, y, w, h, area in groups[1:]:
        if w >= 21 and 4 <= h <= 34 and w >= 2 * h and area >= .28 * w * h:
            text[y:y + h, x:x + w] = 1
    return text


def inset_positions(
    anchor,
    changes,
    detector,
    *,
    display_sizes=None,
    protect_dense_strokes=False,
    allow_edge_midpoints=False,
    max_edge_density=.045,
):
    if detector is None:
        return None
    h, w = anchor.shape[:2]
    occupied = text_regions(anchor)
    try:
        for scale in (1, 1.5):
            image = cv2.resize(anchor, None, fx=scale, fy=scale) if scale != 1 else anchor
            detector.setInputSize((image.shape[1], image.shape[0]))
            _, faces = detector.detect(image)
            for row in ([] if faces is None else faces):
                x, y, fw, fh = row[:4] / scale
                cv2.rectangle(occupied, (int(x - .12 * fw), int(y - .14 * fh)),
                              (int(x + 1.12 * fw), int(y + 1.08 * fh)), 1, -1)
    except cv2.error:
        return None
    motion = np.zeros((h, w), bool)
    sizes = []
    for _, _, image, box in changes:
        l, t, r, b = box
        occupied[t:b, l:r] = 1
        motion |= cv2.absdiff(anchor, image).max(axis=2) >= 20
        sizes.append((r - l, b - t))
    if display_sizes is not None:
        sizes = display_sizes
    if sum(i * j for i, j in sizes) > .26 * w * h:
        return None
    edges = cv2.Canny(cv2.cvtColor(anchor, cv2.COLOR_BGR2GRAY), 28, 65) > 0
    if protect_dense_strokes:
        # A short platform number can occupy too little of a large inset to
        # register in its average edge density. Protect concentrated strokes.
        dense = cv2.boxFilter(edges.astype(np.float32), -1, (11, 11)) > .14
        occupied |= cv2.dilate(dense.astype(np.uint8), np.ones((5, 5), np.uint8))
    choices = []
    for horizontal in (False, True):
        offsets = []
        x = y = 0
        for cw, ch in sizes:
            offsets.append((x, y, cw, ch))
            if horizontal:
                x += cw + 2
            else:
                y += ch + 2
        aw = max(x + cw for x, y, cw, ch in offsets)
        ah = max(y + ch for x, y, cw, ch in offsets)
        if aw + 10 > w or ah + 10 > h:
            continue
        origins = [(w - aw - 4, 4), (4, 4), (w - aw - 4, h - ah - 4), (4, h - ah - 4)]
        if allow_edge_midpoints:
            origins.extend([((w - aw) // 2, 4), ((w - aw) // 2, h - ah - 4),
                            (4, (h - ah) // 2), (w - aw - 4, (h - ah) // 2)])
        for rank, (cx, cy) in enumerate(origins):
            rectangles = [(cx + x, cy + y, cw, ch) for x, y, cw, ch in offsets]
            cost = rank * .004
            for x, y, cw, ch in rectangles:
                area = np.s_[y - 1:y + ch + 1, x - 1:x + cw + 1]
                movement, detail = motion[area].mean(), edges[area].mean()
                if occupied[area].any() or movement > .075 or detail > max_edge_density:
                    break
                cost += movement + detail
            else:
                choices.append((cost, rectangles))
    return min(choices, key=lambda pair: pair[0])[1] if choices else None
