"""Render motion-selected panoramas and magnified source details for the full profile."""
import math

import cv2

from storyboard_images import (StoryboardInset, StoryboardPicture, contextual_changes, fitted_size, render_crop, scaled_box,
                               storyboard_sources)
from storyboard_insets import inset_positions
from storyboard_selection import (PreparedScene, RECENT_SCENE_CHANGE_MS, quiet_preroll,
                                  scene_frame, select_scene_views)

FALLBACK_HEIGHTS = (720, 480)


def native_detail(before, after, preview):
    """Look for coherent strokes lost when a nearly static shot was downsampled."""
    if before.shape != after.shape:
        return 1, None
    delta = cv2.absdiff(before, after)
    b, g, r = cv2.split(delta)
    strength = cv2.max(cv2.max(b, g), r)
    mask = cv2.inRange(cv2.blur(strength, (3, 3)), 18, 255)
    count = cv2.countNonZero(mask)
    if count < 6 or count > mask.size * .015:
        return 0, None
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = [cv2.boundingRect(c) for c in contours if cv2.contourArea(c) >= 4]
    if not boxes:
        return 0, None
    l, t = min(x for x,y,w,h in boxes), min(y for x,y,w,h in boxes)
    r, b = max(x+w for x,y,w,h in boxes), max(y+h for x,y,w,h in boxes)
    h, w = strength.shape
    if (r-l)*(b-t) > .30*w*h:
        return count, None
    ph, pw = preview.shape[:2]
    return count, (math.floor(l*pw/w), math.floor(t*ph/h), math.ceil(r*pw/w), math.ceil(b*ph/h))


def full_pictures(frames, times, review, detector, height, *,
                  prepared_views=frozenset(), scene=None, frame_reason=None):
    scene = PreparedScene() if scene is None else scene
    sources, review = storyboard_sources(frames, times, review)
    references = ({scene.anchor[0]: scene.anchor_source, scene.latest[0]: scene.latest_source}
                  if scene.latest is not None else {})

    def recover(start, end, preview, *, candidate_only=False):
        before = references[start] if start in references else sources[start]
        times_to_check = [end] if candidate_only else sorted(t for t in sources if start < t <= end)
        best_time, best_score, best_box = end, 0, None
        for ts in times_to_check:
            score, box = native_detail(before, sources[ts], preview)
            if score > best_score:
                best_time, best_score, best_box = ts, score, box
        if best_score:
            return [(best_time, preview if best_time == end else scene_frame(sources[best_time]), best_box)]
        return []

    cut_duplicates = None
    if (frame_reason == 'scene_change' and scene.latest is not None
            and times[-1] - scene.latest[0] <= RECENT_SCENE_CHANGE_MS):
        tail = times[-1], scene_frame(frames[-1])
        cut_duplicates = set()
        for index, (time, frame) in enumerate(zip(times[:-1], frames[:-1])):
            preview = scene_frame(frame)
            for ref_time, reference in (scene.latest, tail):
                if quiet_preroll(reference, preview) and not recover(ref_time, time, preview, candidate_only=True):
                    cut_duplicates.add(index)
                    break

    records = select_scene_views(frames, times, review, locate_crops=True, detail_review=recover,
                                 scene=scene, prepared_views=prepared_views, cut_duplicates=cut_duplicates)
    pictures = []
    i = 0
    while i < len(records):
        index, time, image, change_box = records[i]
        picture = None
        if change_box is None:
            source = sources[time]
            size = fitted_size(source, round(height * 16 / 9), height)
            canvas = cv2.resize(source, size, interpolation=cv2.INTER_AREA)
            views = [dict(sourceIndex=index, mediaTimeMs=time, type='full', box=[0, 0, *size])]
            picture = StoryboardPicture(canvas, views)
            pictures.append(picture)
            i += 1
            if scene.latest is not None and time < scene.latest[0]:
                continue
            scene.anchor = scene.latest = (time, image)
            scene.anchor_source = scene.latest_source = source
        anchor_time, anchor = scene.anchor
        h, w = anchor.shape[:2]
        size = fitted_size(scene.anchor_source, round(height * 16 / 9), height)
        changes, crops, i = contextual_changes(records, i, sources, prepared_views)
        sizes = []
        for _, _, _, (l, t, r, b) in changes:
            zoom = min(1.6, w / (r - l), h / (b - t))
            sizes.append((max(1, round((r - l) * zoom)), max(1, round((b - t) * zoom))))
        positions = (
            inset_positions(anchor, changes, detector, display_sizes=sizes,
                            protect_dense_strokes=True, allow_edge_midpoints=True)
            if picture is not None and changes else None
        )
        if picture is not None and changes and positions is None and detector is not None:
            # A modest enlargement can fit beside a face when the preferred one cannot.
            smaller = [(min(w, round((r - l) * 1.1)), min(h, round((b - t) * 1.1)))
                       for _, _, _, (l, t, r, b) in changes]
            positions = inset_positions(anchor, changes, detector, display_sizes=smaller,
                                        protect_dense_strokes=True, allow_edge_midpoints=True)
        for n, (change, crop) in enumerate(zip(changes, crops)):
            x, y, cw, ch = positions[n] if positions else (0, 0, *sizes[n])
            x, y, right, bottom = scaled_box((x, y, x + cw, y + ch), (w, h), size)
            piece, view = render_crop(change, crop, anchor_time, (x, y, right - x, bottom - y), cv2)
            if positions:
                border = max(1, round(size[1] / 268))
                picture.insets.append(StoryboardInset(piece, view, border))
            else:
                pictures.append(StoryboardPicture(piece, [view]))
            _, time, image, _ = change
            if time > scene.latest[0]:
                scene.latest = time, image
                scene.latest_source = sources[time]
    return pictures
