"""Compose balanced-profile panoramas, insets and separate crops at scene scale."""
import cv2
import numpy as np

from storyboard_images import (StoryboardInset, StoryboardPicture, contextual_changes, render_crop,
                               storyboard_sources)
from storyboard_insets import inset_positions
from storyboard_selection import PreparedScene, RECENT_SCENE_CHANGE_MS, different_shot, select_scene_views
SHORT_GROUP_MS = 2500


def compose_images(records, sources, detector, prepared_views, scene):
    images = []

    def append_panorama(picture):
        if (images and images[-1].views[0]['type'] == 'full'
                and images[-1].pixels.shape[0] == picture.pixels.shape[0]):
            prior = images[-1]
            for _, view in picture.content():
                view['box'][0] += prior.pixels.shape[1]
            prior.pixels = np.hstack((prior.pixels, picture.pixels))
            prior.views.extend(picture.views)
            prior.insets.extend(picture.insets)
            return
        images.append(picture)

    i = 0
    while i < len(records):
        index, time, image, change_box = records[i]
        picture = None
        if change_box is None:
            h, w = image.shape[:2]
            picture = StoryboardPicture(image.copy(), [dict(sourceIndex=index, mediaTimeMs=time, type='full',
                                                             box=[0, 0, w, h])])
            scene.anchor = scene.latest = (time, image)
            i += 1
        anchor_time, anchor = scene.anchor
        changes, crops, i = contextual_changes(records, i, sources, prepared_views)
        positions = (inset_positions(anchor, changes, detector, allow_edge_midpoints=True, max_edge_density=.09)
                     if picture is not None and changes else None)
        separate = []
        for n, (change, crop) in enumerate(zip(changes, crops)):
            _, time, image, (left, top, right, bottom) = change
            box = positions[n] if positions else (0, 0, right - left, bottom - top)
            piece, view = render_crop(change, crop, anchor_time, box, cv2)
            if positions:
                picture.insets.append(StoryboardInset(piece, view, 1))
            else:
                separate.append(StoryboardPicture(piece, [view]))
            if time > scene.latest[0]:
                scene.latest = (time, image)
        if picture is not None:
            append_panorama(picture)
        images.extend(separate)
    return images


def balanced_pictures(frame_at, times_ms, review=None, face_detector=None, *,
                      prepared_views=frozenset(), scene=None, frame_reason=None):
    scene = PreparedScene() if scene is None else scene
    end = times_ms[-1]
    gap = end - scene.latest[0] if scene.latest is not None else float('inf')
    frames = [frame_at(time) for time in times_ms]
    if frame_reason == 'scene_change' and gap <= RECENT_SCENE_CHANGE_MS:
        indices = [index for index, frame in enumerate(frames[:-1])
                   if different_shot(scene.latest[1], frame) and different_shot(frames[-1], frame)]
        indices.append(len(times_ms) - 1)
        selected = [frames[index] for index in indices]
        times = [times_ms[index] for index in indices]
        records = select_scene_views(selected, times, None, locate_crops=True,
                                     prepared_views=prepared_views, source_indices=indices)
        return compose_images(records, dict(zip(times, selected)), face_detector, prepared_views, scene)

    sources, review = storyboard_sources(frames, times_ms, review)
    records = select_scene_views(frames, times_ms, review, locate_crops=True,
                                 scene=scene, prepared_views=prepared_views)
    if end - times_ms[0] <= SHORT_GROUP_MS:
        full_indices = [index for index, record in enumerate(records) if record[3] is None]
        if len(full_indices) >= 2 and gap <= SHORT_GROUP_MS:
            records = prune_panoramas(records, full_indices, scene.latest[1], frames[-1])
        elif len(full_indices) == 3:
            records = prune_panoramas(records, full_indices[1:], frames[0], frames[-1])
    return compose_images(records, sources, face_detector, prepared_views, scene)


def prune_panoramas(records, full_indices, earlier, tail):
    # A panorama with a local view is still needed as that view's anchor.
    redundant = {start for start, end in zip(full_indices, full_indices[1:]) if end == start + 1
                 and (not different_shot(earlier, records[start][2]) or not different_shot(tail, records[start][2]))}
    return [record for index, record in enumerate(records) if index not in redundant]


def balanced_parts(pictures):
    parts = []
    separate = []
    for picture in pictures:
        for pixels, views in picture.rendered(cv2):
            if views[0]['type'] == 'crop':
                separate.append((pixels, views[0]))
            else:
                parts.append((pixels, views))
    if len(separate) == 1:
        pixels, view = separate[0]
        parts.append((pixels, [view]))
    elif separate:
        separate.sort(key=lambda pair: pair[1]['mediaTimeMs'])
        height = max(pixels.shape[0] for pixels, _ in separate)
        width = sum(pixels.shape[1] for pixels, _ in separate) + len(separate) - 1
        strip = np.full((height, width, 3), 12, dtype=np.uint8)
        x = 0
        views = []
        for pixels, view in separate:
            h, w = pixels.shape[:2]
            y = (height - h) // 2
            strip[y:y + h, x:x + w] = pixels
            views.append({**view, 'box': [x, y, w, h]})
            x += w
            if x < width:
                strip[:, x] = (175, 191, 205)
                x += 1
        parts.append((strip, views))
    return sorted(parts, key=lambda part: max(view['mediaTimeMs'] for view in part[1]))
