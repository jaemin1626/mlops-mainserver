import os
import tempfile
import time
import unittest
from pathlib import Path

from seoul_studio.comfy_client import (
    _pick_preferred_media_file,
    _sync_preview_png_number,
    apply_custom_output_name,
    find_newest_video_file,
    parse_media_basename,
    persist_output_video,
    resolve_best_video_output,
)
from seoul_studio.job import sanitize_output_name


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

    def test_resolve_best_video_output_ignores_stale_higher_numbered_file(self) -> None:
        # 이전(무관한) 작업이 남긴, 번호는 더 크지만 이번 작업 시작 전에 만들어진 파일을
        # min_mtime으로 걸러서 엉뚱한 영상이 선택되지 않도록 한다.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stale = root / "Gen_Fire_Local_00099-audio.mp4"
            stale.write_text("unrelated old job", encoding="utf-8")
            stale_mtime = time.time() - 3600
            os.utime(stale, (stale_mtime, stale_mtime))

            job_started_at = time.time()
            outputs = {
                "140": {
                    "gifs": [{"filename": "Gen_Fire_Local_00005-audio.mp4", "type": "output"}],
                }
            }
            resolved = resolve_best_video_output(
                outputs, root, root, min_mtime=job_started_at
            )
            self.assertEqual(resolved["filename"], "Gen_Fire_Local_00005-audio.mp4")

    def test_resolve_best_video_output_ignores_unrelated_concurrent_job(self) -> None:
        # 이 ComfyUI 서버는 다른 도구/워크플로와 공유될 수 있다. 같은 prefix를 쓰는
        # 무관한 작업이 우리 작업과 거의 동시에(= min_mtime을 통과할 만큼 최근에) 끝나도,
        # 번호 차이가 너무 크면(MAX_OUTPUT_SEQUENCE_DRIFT 초과) 그 파일을 고르지 않는다.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            job_started_at = time.time()
            unrelated = root / "Gen_Fire_Local_00500-audio.mp4"
            unrelated.write_text("unrelated concurrent job", encoding="utf-8")
            outputs = {
                "140": {
                    "gifs": [{"filename": "Gen_Fire_Local_00005-audio.mp4", "type": "output"}],
                }
            }
            resolved = resolve_best_video_output(
                outputs, root, root, min_mtime=job_started_at
            )
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

    def test_sanitize_output_name(self) -> None:
        self.assertEqual(sanitize_output_name("  my clip  "), "my clip")
        self.assertEqual(sanitize_output_name('bad/name:*?"<>|end'), "bad_name_______end")
        self.assertEqual(sanitize_output_name("   "), None)
        self.assertEqual(sanitize_output_name(None), None)
        self.assertEqual(sanitize_output_name("a" * 200), "a" * 80)

    def test_apply_custom_output_name_renames_video_and_preview(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            save_dir = Path(tmp)
            video = save_dir / "Gen_Fire_Local_00005-audio.mp4"
            video.write_text("video", encoding="utf-8")
            preview = save_dir / "Gen_Fire_Local_00005.png"
            preview.write_text("preview", encoding="utf-8")

            result = apply_custom_output_name(video, "my great clip")

            self.assertEqual(result, save_dir / "my great clip.mp4")
            self.assertTrue(result.is_file())
            self.assertTrue((save_dir / "my great clip.png").is_file())
            self.assertFalse(video.exists())
            self.assertFalse(preview.exists())

    def test_apply_custom_output_name_avoids_collision(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            save_dir = Path(tmp)
            (save_dir / "clip.mp4").write_text("existing", encoding="utf-8")
            video = save_dir / "Gen_Fire_Local_00005-audio.mp4"
            video.write_text("video", encoding="utf-8")

            result = apply_custom_output_name(video, "clip")

            self.assertEqual(result, save_dir / "clip_2.mp4")
            self.assertTrue(result.is_file())

    def test_apply_custom_output_name_noop_without_name(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            video = Path(tmp) / "Gen_Fire_Local_00005-audio.mp4"
            video.write_text("video", encoding="utf-8")
            self.assertEqual(apply_custom_output_name(video, None), video)


if __name__ == "__main__":
    unittest.main()
