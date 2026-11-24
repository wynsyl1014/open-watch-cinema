"""Select candidate times, review motion and locate details shared by the viewing profiles."""
import math
import subprocess
from dataclasses import dataclass

import cv2
import numpy as np


SMOOTH_PAN_LIMIT = .22
SCENE_REFRESH_MS = 15_000
RECENT_SCENE_CHANGE_MS = 3500


@dataclass
class PreparedScene:
    anchor: tuple[int, np.ndarray] | None = None
    latest: tuple[int, np.ndarray] | None = None
    anchor_source: np.ndarray | None = None
    latest_source: np.ndarray | None = None


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
    # Different times in a similar-looking shot delimit the interval for motion review.
    for i in reversed(context):
        if len(chosen) == 3:
            break
        if i not in chosen:
            chosen.append(i)
    return sorted(chosen)


def hashes_similar(left: dict, right: dict) -> bool:
    a, b = left.get("perceptualHash"), right.get("perceptualHash")
    # pHash alone treats differently coloured flat frames as identical.
    return bool(a and b and (int(a, 16) ^ int(b, 16)).bit_count() <= 4
                and max(abs(x - y) for x, y in zip(left["averageRgb"], right["averageRgb"])) < 0.08)


def scene_frame(frame):
    height, width = frame.shape[:2]
    scale = min(476 / width, 268 / height, 1)
    size = max(1, round(width * scale)), max(1, round(height * scale))
    return cv2.resize(frame, size, interpolation=cv2.INTER_AREA)


def different_shot(before, after):
    """Compare the composition and color of two available frames."""
    left, right = [cv2.resize(frame, (96, 54), interpolation=cv2.INTER_AREA) for frame in (before, after)]
    gray_left, gray_right = [cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) for frame in (left, right)]
    histograms = [cv2.calcHist([cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)], [0, 1], None,
                              [16, 8], [0, 180, 0, 256]) for frame in (left, right)]
    color = cv2.compareHist(*histograms, cv2.HISTCMP_BHATTACHARYYA)
    difference = cv2.absdiff(gray_left, gray_right).mean() / 255
    edge_change = abs(cv2.Canny(gray_left, 60, 140).mean() - cv2.Canny(gray_right, 60, 140).mean()) / 255
    return .62 * color + 1.35 * difference + .85 * edge_change >= .34


def flat_frame(frame):
    """Distinguish a faint, shapeless field from lettering and dark outlines."""
    channels = cv2.split(frame)
    ranges = [int(v.max()) - int(v.min()) for v in channels]
    if not max(ranges):
        return True
    if max(ranges) > 56:
        return False
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    if cv2.countNonZero(cv2.Canny(gray, 28, 65)) >= 16:
        return False
    for v, span in zip(channels, ranges):
        if not span:
            continue
        # A two-tone title, silhouette or line can have just two digital
        # levels of contrast, even in one channel of an isoluminant frame.
        if span >= 2 and np.count_nonzero(np.bincount(v.ravel())) == 2:
            return False
        intensity = v.astype(np.float32)
        detail = intensity - cv2.GaussianBlur(intensity, (0, 0), 4)
        threshold = max(1.25, 3.5 * float(np.percentile(np.abs(detail), 97)))
        for direction in (-1, 1):
            strong = np.uint8(direction * detail > threshold)
            if not strong.any():
                continue
            _, _, components, _ = cv2.connectedComponentsWithStats(strong)
            for _, _, w, h, area in components[1:]:
                if area >= 7 and max(w, h) >= 5:
                    return False
    return True


def track_affine(gray, later, points, shift=None):
    flags = cv2.OPTFLOW_USE_INITIAL_FLOW if shift is not None else 0
    estimate = points + np.asarray(shift, dtype=np.float32) if flags else None
    mapped, ok, _ = cv2.calcOpticalFlowPyrLK(gray, later, points, estimate, flags=flags)
    back, ok2, _ = cv2.calcOpticalFlowPyrLK(later, gray, mapped, points.copy() if flags else None, flags=flags)
    valid = ok.ravel().astype(bool) & ok2.ravel().astype(bool)
    valid &= np.linalg.norm(points - back, axis=2).ravel() < 1.5
    if valid.sum() < 7:
        return None
    matrix, inliers = cv2.estimateAffinePartial2D(
        points[valid], mapped[valid], method=cv2.RANSAC, ransacReprojThreshold=2)
    if matrix is None or np.count_nonzero(inliers) < max(7, .27 * len(points)):
        return None
    return matrix


def align_frames(before, after, *, smooth_pans=False):
    """Return the residual, camera translation, registered reference and overlap."""
    gray, later = [cv2.cvtColor(im, cv2.COLOR_BGR2GRAY) for im in (before, after)]
    points = cv2.goodFeaturesToTrack(gray, 300, .008, 6)
    if points is None or len(points) < 7:
        return None
    height, width = gray.shape
    max_shift_ratio = SMOOTH_PAN_LIMIT if smooth_pans else .12
    matrix = track_affine(gray, later, points)
    if matrix is None and smooth_pans:
        # Large translations can move beyond the search range of unseeded optical flow.
        window = cv2.createHanningWindow((width, height), cv2.CV_32F)
        shift, response = cv2.phaseCorrelate(gray.astype(np.float32), later.astype(np.float32), window)
        if response >= .2 and 6 < math.hypot(*shift) <= max_shift_ratio * width:
            matrix = track_affine(gray, later, points, shift)
    if matrix is None:
        return None
    translation = matrix[:, 2]
    if np.linalg.norm(translation) > max_shift_ratio * width or np.max(np.abs(matrix[:, :2] - np.eye(2))) > .19:
        return None
    aligned = cv2.warpAffine(before, matrix, (width, height), borderMode=cv2.BORDER_REPLICATE)
    support = cv2.warpAffine(np.full_like(gray, 255), matrix, (width, height))
    if smooth_pans:
        # Ignore the blur's two-pixel rim at the edge of registered overlap.
        support = cv2.erode(support, np.ones((5, 5), np.uint8))
    delta = cv2.absdiff(cv2.GaussianBlur(aligned, (5, 5), 0),
                        cv2.GaussianBlur(after, (5, 5), 0)).max(axis=2)
    unsupported = support < 255
    delta[unsupported] = 0
    aligned[unsupported] = after[unsupported]
    return delta, translation, aligned, np.count_nonzero(~unsupported)


def local_action(before, after):
    """Locate a coherent local change while ignoring outline jitter and tiny shifts.

    Returns ('crop', (l, t, r, b)), ('full', None), or ('review', None).
    """
    height, width = before.shape[:2]
    size = 8
    rows, cols = math.ceil(height / size), math.ceil(width / size)
    change = cv2.absdiff(before, after).astype(np.float32)
    energy = np.mean(change * change, axis=2)
    padded = cv2.copyMakeBorder(energy, 0, rows * size - height, 0, cols * size - width,
                                cv2.BORDER_CONSTANT)
    totals = padded.reshape(rows, size, cols, size).sum(axis=(1, 3))
    tile_height = np.minimum(size, height - np.arange(rows) * size)
    tile_width = np.minimum(size, width - np.arange(cols) * size)
    active = totals > 36 * tile_height[:, None] * tile_width
    scores = np.zeros((rows, cols), np.float32)
    for i, j in zip(*np.where(active)):
        l, t = int(j * size), int(i * size)
        r, b = min(l + size, width), min(t + size, height)
        for old, new in ((before, after), (after, before)):
            patch = new[t:b, l:r]
            area = old[max(0, t - 7):b + 7, max(0, l - 7):r + 7]
            cost = cv2.matchTemplate(area, patch, cv2.TM_SQDIFF).min()
            scores[i, j] = max(scores[i, j], math.sqrt(max(0, cost) / patch.size))
    active = scores > 6
    joined = cv2.dilate(active.astype(np.uint8), np.ones((3, 3), np.uint8))
    count, labels, _, _ = cv2.connectedComponentsWithStats(joined)
    ranked = []
    for label in range(1, count):
        region = (labels == label) & active
        cells = int(region.sum())
        if cells < 4:
            continue
        x, y, w, h = cv2.boundingRect(region.astype(np.uint8))
        l, t, r, b = size * x, size * y, min(width, size * (x + w)), min(height, size * (y + h))
        score = min(float(np.square(scores[region] - 6).sum()), cells * 160)
        if (l <= 8 or r >= width - 8) and r - l < .10 * width:
            score *= .10
        ranked.append((score, (l, t, r, b)))
    if not ranked:
        return "review", None
    ranked.sort(reverse=True)
    best, (l, t, r, b) = ranked[0]
    if best < 55:
        return "review", None
    for score, (x, y, right, bottom) in ranked[1:]:
        if score < .30 * best:
            break
        ll, tt, rr, bb = min(l, x), min(t, y), max(r, right), max(b, bottom)
        if (rr - ll) * (bb - tt) <= .16 * width * height and rr - ll < .60 * width:
            l, t, r, b = ll, tt, rr, bb
        elif score > .52 * best:
            return "full", None
    if (r - l) * (b - t) > .25 * width * height or r - l > .80 * width or b - t > .80 * height:
        return "full", None
    dx, dy = max(14, round((r - l) * .18)), max(12, round((b - t) * .15))
    return "crop", (max(0, l - dx), max(0, t - dy), min(width, r + dx), min(height, b + dy))


def tiny_detail_box(delta, width, height):
    """Locate a crisp, compact detail (e.g. a sweat drop or sparkle) smaller than 4 tiles."""
    if int(delta.max()) < 28 or float(np.mean(delta >= 12)) >= .02:
        return None
    mask = np.uint8(delta >= 12)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
    valid = np.zeros(count, dtype=bool)
    valid[np.unique(labels[delta >= 28])] = True
    valid[0] = False
    effective = np.uint8(valid[labels])
    if not effective.any():
        return None
    x, y, rw, rh = cv2.boundingRect(effective)
    if rw * rh > .25 * width * height or rw > .80 * width or rh > .80 * height:
        return None
    dx, dy = max(14, round(rw * .18)), max(12, round(rh * .15))
    return max(0, x - dx), max(0, y - dy), min(width, x + rw + dx), min(height, y + rh + dy)


def compare_frames(before, after, *, smooth_pans=False):
    """Classify a change, including the translation of a clean pan when enabled."""
    if before.shape != after.shape:
        return "full", None
    height, width = before.shape[:2]
    delta = cv2.absdiff(before, after).max(axis=2)
    if int(delta.max()) <= 22 and float(np.mean(delta >= 10)) < .0002:
        return "review", None
    fraction = float(np.mean(delta >= 16))
    if fraction >= .75 and not smooth_pans:
        return "full", None
    aligned = align_frames(before, after, smooth_pans=smooth_pans)
    shift = np.linalg.norm(aligned[1]) if aligned is not None else 0
    if (smooth_pans and aligned is not None and shift > 6
            and (shift > .12 * width or fraction >= .75)
            and np.count_nonzero(aligned[0] >= 16) < .035 * aligned[3]):
        return "pan", aligned[1]
    if fraction >= .75:
        return "full", None
    if fraction >= .25:
        # A slow camera move may alter many pixels yet leave the scene unchanged.
        if aligned is not None and float(np.mean(aligned[0] >= 16)) < .14:
            return "review", None
        return "full", None
    # Moderate pixel change: rule out a clean camera pan before localizing action.
    if shift > 6.0 and float(np.mean(aligned[0] >= 16)) < .05:
        return "review", None
    kind, box = local_action(before, after)
    if kind != "review":
        return kind, box
    # Tiny crisp marks on a still shot can fall below the 4-tile threshold.
    if shift < 1.5:
        tiny = tiny_detail_box(delta, width, height)
        if tiny is not None:
            return "crop", tiny
    # If global alignment shows the overall scene stayed intact, verify at 8 fps
    # to capture the peak moment or drop truly static endpoints.
    if aligned is not None and float(np.mean(aligned[0] >= 16)) < .14:
        return "review", None
    return "full", None


def quiet_preroll(before, after):
    """Check for small changes before a cut without mistaking a pan for a still shot."""
    if before.shape != after.shape or different_shot(before, after):
        return False
    delta = cv2.absdiff(before, after).max(axis=2)
    return float(np.mean(delta >= 16)) < .035 and compare_frames(before, after, smooth_pans=True)[0] == 'review'


def evidence_box(grid, peak, width, height):
    mask = np.uint8(grid > max(1.6, peak * .19))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((2, 2), np.uint8))
    count, labels, _, _ = cv2.connectedComponentsWithStats(mask)
    if count <= 1:
        return None
    weights = np.bincount(labels.ravel(), weights=grid.ravel(), minlength=count)
    weights[0] = 0
    ys, xs = np.where(np.isin(labels, np.flatnonzero(weights >= .19 * weights.max())))
    left = max(0, int(xs.min() * width / 30) - 44)
    right = min(width, math.ceil((xs.max() + 1) * width / 30) + 44)
    top = max(0, int(ys.min() * height / 17) - 32)
    bottom = min(height, math.ceil((ys.max() + 1) * height / 17) + 32)
    if (right - left) * (bottom - top) <= .68 * width * height:
        return left, top, right, bottom
    return None


def _is_compression_noise(left, right) -> bool:
    delta = cv2.absdiff(left, right).max(axis=2)
    return int(delta.max()) <= 12 and float(np.mean(delta >= 8)) < .0005


def review_candidate(before, after, start, end, review, *, smooth_pans=False):
    fallback = [(end, after, None)]
    limit = SCENE_REFRESH_MS if smooth_pans else 3000
    if review is None or not 0 < end - start <= limit:
        return fallback
    sequence = [(start, before)]
    try:
        samples = review(start, end)
        if samples is None:
            return fallback
        for time, frame in samples:
            if start < time < end:
                sequence.append((time, scene_frame(frame)))
    except (OSError, RuntimeError, TimeoutError, subprocess.SubprocessError, cv2.error):
        return fallback
    sequence.append((end, after))
    if any(t2 <= t1 or t2 - t1 > 150 or b.shape != a.shape
           for (t1, a), (t2, b) in zip(sequence, sequence[1:])):
        return fallback
    height, width = before.shape[:2]
    strongest = None
    max_peak = 0.0
    for (_, previous), (time, current) in zip(sequence, sequence[1:]):
        if np.array_equal(current, before) and np.array_equal(previous, before):
            continue
        alignment = align_frames(before, current, smooth_pans=smooth_pans)
        if alignment is None:
            if _is_compression_noise(before, current):
                continue
            # Lost tracks can be the only evidence of a cut or a rapid action.
            return [(time, current, None)] + (fallback if time < end else [])
        if previous is not before and align_frames(previous, current, smooth_pans=smooth_pans) is None:
            if not _is_compression_noise(previous, current):
                return [(time, current, None)] + (fallback if time < end else [])
        delta, _, reference, _ = alignment
        grid = cv2.resize(np.maximum(delta.astype(np.float32) - 5, 0), (30, 17),
                          interpolation=cv2.INTER_AREA)
        peak = float(cv2.blur(grid, (3, 3)).max())
        max_peak = max(max_peak, peak)
        score = peak * (1 + .10 * (time - start) / (end - start))
        if strongest is None or score > strongest[0]:
            strongest = (score, peak, time, current, grid, reference)
    if max_peak < 1.5:
        return []
    _, peak, time, current, grid, reference = strongest
    if local_action(reference, current)[0] == "full":
        return [(time, current, None)]
    box = evidence_box(grid, peak, width, height)
    return [(time, current, box)]


def revisited_view(index, time, image, scene, detail_review, *, keep_candidate):
    """Preserve fresh evidence in candidates preceding the last displayed view."""
    latest_time, latest = scene.latest
    anchor_time, anchor = scene.anchor
    if detail_review is None:
        if time > anchor_time:
            kind, box = compare_frames(latest, image, smooth_pans=True)
            if kind == 'crop' and compare_frames(anchor, image, smooth_pans=True)[0] == 'crop':
                return index, time, image, box
        return None

    crops = []
    for ref_time, reference in ((latest_time, latest), (anchor_time, anchor)):
        kind, box = compare_frames(reference, image, smooth_pans=True)
        if kind == 'review':
            native = detail_review(ref_time, time, image, candidate_only=True)
            if not native and not keep_candidate:
                return None
            box = native[0][2] if native else None
        crops.append(box if kind in ('crop', 'review') else None)
    return index, time, image, crops[0] if time > anchor_time and all(box is not None for box in crops) else None


def select_scene_views(frames, times_ms, review, *, locate_crops, detail_review=None,
                       scene=None, prepared_views=frozenset(), source_indices=None, cut_duplicates=None):
    """Select chronological full scenes at detection resolution, before profile layout."""
    records = []
    previous = previous_time = None
    smooth_pans = scene is not None
    pan_links = {}
    redundant = set()
    if scene is not None and scene.latest is not None:
        previous_time, previous = scene.latest
    group_reference_time = previous_time
    indices = range(len(times_ms)) if source_indices is None else source_indices
    for index, frame, time in zip(indices, frames, times_ms):
        if time == previous_time or ('full', time) in prepared_views:
            continue
        image = scene_frame(frame)
        duplicate_preroll = cut_duplicates is not None and index in cut_duplicates
        if scene is not None and previous_time is not None and time < previous_time:
            if not duplicate_preroll:
                item = revisited_view(index, time, image, scene, detail_review, keep_candidate=cut_duplicates is not None)
                if item is not None:
                    records.append(item)
            continue
        if flat_frame(image) and (detail_review is None or flat_frame(frame)):
            previous, previous_time = None, time
            continue
        crossed_cut = cut_duplicates is not None and previous is not None and different_shot(previous, image)
        if duplicate_preroll and (previous is None or crossed_cut):
            continue
        updates = [(time, image, None)]
        from_detail = False
        if previous is not None:
            kind, box = ('full', None) if crossed_cut else compare_frames(previous, image, smooth_pans=smooth_pans)
            if kind == 'crop':
                updates = [(time, image, box if locate_crops else None)]
            elif kind in ('review', 'pan'):
                updates = review_candidate(previous, image, previous_time, time, review, smooth_pans=smooth_pans)
                if kind == 'pan':
                    if not updates and cut_duplicates is None:
                        prior = pan_links.get(previous_time)
                        if prior is not None and np.dot(prior, box) > .95 * np.linalg.norm(prior) * np.linalg.norm(box):
                            redundant.add(previous_time)
                        pan_links[time] = box
                    # Keep the new edge of the scene as well as any action found during the pan.
                    updates = [(ts, part, None) for ts, part, _ in updates if ts < time] + [(time, image, None)]
                elif not updates and detail_review is not None:
                    updates = detail_review(previous_time, time, image)
                    from_detail = True
                elif (detail_review is not None and previous_time == group_reference_time
                      and not duplicate_preroll and updates[-1][0] < time
                      and not _is_compression_noise(previous, image)):
                    # A stronger pose in the inter-group interval can coexist with
                    # another distinct pose at the first timestamp of this group.
                    updates.append((time, image, None))
                if not locate_crops:
                    updates = [(ts, part, None) for ts, part, _ in updates]
        if duplicate_preroll and kind == 'review' and not detail_review(previous_time, time, image, candidate_only=True):
            # A static endpoint is redundant, but motion recovered between candidates is still useful.
            updates = [(ts, part, box) for ts, part, box in updates if ts < time or box is not None]
        elif cut_duplicates is not None and not duplicate_preroll and not any(ts == time for ts, _, _ in updates):
            updates.append((time, image, None))
        for ts, part, box in updates:
            if ('full', ts) not in prepared_views and (from_detail or not flat_frame(part)):
                records.append((index, ts, part, box))
        # Skipped pre-roll may precede the first visible frame of its shot. Keep
        # using the last eligible reference so a later crop has a real anchor.
        if updates or not duplicate_preroll:
            previous, previous_time = image, time
    return [record for record in records if record[1] not in redundant] if redundant else records
