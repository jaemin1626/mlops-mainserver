import tempfile
import unittest
from pathlib import Path

from seoul_studio.comfy_client import (
    _pick_preferred_media_file,
    _sync_preview_png_number,
    find_newest_video_file,
    parse_media_basename,
    persist_output_video,
    resolve_best_video_output,
)


class ComfyMediaTests(unittest.TestCase):
    def test_parse_media_basename(self) -> None:
        self.assertEqual(
            parse_media_basename("Gen_Fire_Local_00007-audio.mp4"),
            ("Gen_Fire_Local", 7, 5),
        )
        self.assertEqual(
            parse_media_basename("Gen_Fire_Local_00003.png"),
            ("Gen_Fire_Local", 3, 5),
        )

    def test_pick_preferred_media_file_prefers_highest_video(self) -> None:
        files = [
            {"filename": "Gen_Fire_Local_00003.png", "subfolder": "", "type": "output"},
            {"filename": "Gen_Fire_Local_00003-audio.mp4", "subfolder": "", "type": "output"},
            {"filename": "Gen_Fire_Local_00007-audio.mp4", "subfolder": "", "type": "output"},
        ]
        picked = _pick_preferred_media_file(files)
        self.assertEqual(picked["filename"], "Gen_Fire_Local_00007-audio.mp4")

    def test_find_newest_video_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "Gen_Fire_Local_00003-audio.mp4").write_text("a", encoding="utf-8")
            (root / "Gen_Fire_Local_00007-audio.mp4").write_text("b", encoding="utf-8")
            found = find_newest_video_file(root, prefix="Gen_Fire_Local")
            self.assertEqual(found.name, "Gen_Fire_Local_00007-audio.mp4")

    def test_resolve_best_video_output_uses_disk_when_newer(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "Gen_Fire_Local_00007-audio.mp4").write_text("b", encoding="utf-8")
            outputs = {
                "140": {
                    "images": [{"filename": "Gen_Fire_Local_00003.png", "type": "output"}],
                    "gifs": [{"filename": "Gen_Fire_Local_00003-audio.mp4", "type": "output"}],
                }
            }
            resolved = resolve_best_video_output(outputs, root, root)
            self.assertEqual(resolved["filename"], "Gen_Fire_Local_00007-audio.mp4")

    def test_resolve_best_video_output_ignores_old_dest_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            save_dir = root / "thisisfolder"
            save_dir.mkdir()
            (save_dir / "Gen_Fire_Local_00007-audio.mp4").write_text("old", encoding="utf-8")
            outputs = {
                "140": {
                    "gifs": [{"filename": "Gen_Fire_Local_00005-audio.mp4", "type": "output"}],
                }
            }
            resolved = resolve_best_video_output(outputs, root, save_dir)
            self.assertEqual(resolved["filename"], "Gen_Fire_Local_00005-audio.mp4")

    def test_persist_output_video_copies_from_root_without_download(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            save_dir = root / "thisisfolder"
            save_dir.mkdir()
            (root / "Gen_Fire_Local_00005-audio.mp4").write_text("video", encoding="utf-8")

            def fail_download(_file_info: dict[str, str]) -> bytes:
                raise AssertionError("download should not be called")

            saved = persist_output_video(
                {"filename": "Gen_Fire_Local_00005-audio.mp4", "subfolder": "", "type": "output"},
                dest=save_dir,
                output_root=root,
                download=fail_download,
            )
            self.assertEqual(saved, (save_dir / "Gen_Fire_Local_00005-audio.mp4").resolve())
            self.assertTrue(saved.is_file())

    def test_sync_preview_png_number_moves_into_save_folder(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            preview = root / "Gen_Fire_Local_00003.png"
            preview.write_text("preview", encoding="utf-8")
            save_dir = root / "thisisfolder"
            save_dir.mkdir()
            video = save_dir / "Gen_Fire_Local_00007-audio.mp4"
            video.write_text("video", encoding="utf-8")
            _sync_preview_png_number(root, video)
            self.assertFalse(preview.exists())
            self.assertTrue((save_dir / "Gen_Fire_Local_00007.png").is_file())
            self.assertFalse((root / "Gen_Fire_Local_00007.png").exists())


if __name__ == "__main__":
    unittest.main()
