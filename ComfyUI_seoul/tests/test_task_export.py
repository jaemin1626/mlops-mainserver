import unittest

from seoul_studio.task_export import safe_video_folder_name, unique_dest_dir, unique_dest_path
from pathlib import Path
import tempfile


class TaskExportTests(unittest.TestCase):
    def test_safe_video_folder_name_uses_video_stem(self) -> None:
        self.assertEqual(
            safe_video_folder_name("folder/sub/my video.mp4"),
            "my_video",
        )

    def test_safe_video_folder_name_fallback(self) -> None:
        self.assertEqual(safe_video_folder_name("!!!.mp4"), "video")

    def test_unique_dest_dir_appends_suffix(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            parent = Path(tmp)
            first = parent / "clip"
            first.mkdir()
            resolved = unique_dest_dir(parent, "clip")
            self.assertEqual(resolved.name, "clip_2")

    def test_unique_dest_path_appends_suffix(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dest_dir = Path(tmp)
            first = dest_dir / "clip.mp4"
            first.write_text("a", encoding="utf-8")
            resolved = unique_dest_path(dest_dir, "clip.mp4")
            self.assertEqual(resolved.name, "clip_2.mp4")


if __name__ == "__main__":
    unittest.main()
