"""Fit selected scenes into the economy profile's small chronological strip."""
from storyboard_images import storyboard_canvas, storyboard_view_key
from storyboard_selection import select_scene_views

ECONOMY_CELL_WIDTH = 221


def economy_images(frames, times_ms, review, settings, cv2, np, *, prepared_views=frozenset()):
    records = select_scene_views(frames, times_ms, review, locate_crops=False)
    records = [record for record in records if storyboard_view_key('full', record[1]) not in prepared_views]
    if not records:
        return []
    height = settings.storyboard_height
    # Original candidates are already in memory. Fit them directly to the small
    # cell; for an action found between candidates, use the actual reviewed frame.
    selected = [frames[index] if time == times_ms[index] else frame for index, time, frame, _ in records]
    strip = storyboard_canvas(selected, height, cv2, np,
                              width=ECONOMY_CELL_WIDTH, gutter_width=1)
    views = [{"sourceIndex": index, "mediaTimeMs": time, "type": "full",
              "box": [i * (ECONOMY_CELL_WIDTH + 1), 0, ECONOMY_CELL_WIDTH, height]}
             for i, (index, time, _, _) in enumerate(records)]
    return [(strip, views)]
