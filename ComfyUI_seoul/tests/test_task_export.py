import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from seoul_studio.task_export import safe_video_folder_name, unique_dest_dir, unique_dest_path, send_videos_to_task, generated_dir


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

    def test_generated_roots_are_inside_vlm_training_tree(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            previous = os.environ.get("SEOUL_STUDIO_DATASETS_DIR")
            os.environ["SEOUL_STUDIO_DATASETS_DIR"] = tmp
            try:
                self.assertEqual(generated_dir("image"), Path(tmp) / "vlm" / "generate")
                self.assertEqual(generated_dir("video"), Path(tmp) / "vlm" / "videos" / "generate")
                self.assertEqual(generated_dir("image", "yolo"), Path(tmp) / "detector" / "generate")
                self.assertEqual(generated_dir("image", "detector"), Path(tmp) / "detector" / "generate")
                self.assertEqual(generated_dir("video", "detector"), Path(tmp) / "detector" / "videos" / "generate")
            finally:
                if previous is None: os.environ.pop("SEOUL_STUDIO_DATASETS_DIR", None)
                else: os.environ["SEOUL_STUDIO_DATASETS_DIR"] = previous

    def test_detector_image_transfer_uses_detector_generate(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            datasets = Path(tmp) / "datasets"
            source = Path(tmp) / "source.mp4"
            source.write_bytes(b"video")
            previous = os.environ.get("SEOUL_STUDIO_DATASETS_DIR")
            os.environ["SEOUL_STUDIO_DATASETS_DIR"] = str(datasets)
            try:
                captured_dirs: list[Path] = []

                def capture_extract(source_path, dest_dir, interval, video_folder_name):
                    captured_dirs.append(Path(dest_dir))
                    return [str(Path(dest_dir) / f"{video_folder_name}_0001.jpg")]

                with mock.patch("seoul_studio.task_export.extract_frames", side_effect=capture_extract):
                    result = send_videos_to_task(
                        [(source, "source.mp4")],
                        target="detector",
                        media_kind="image",
                        frame_interval=30,
                        folder_name="smoking_001",
                    )
                self.assertEqual(result["target"], "detector")
                self.assertEqual(
                    Path(result["dest_root"]).parent,
                    datasets / "detector" / "generate",
                )
                self.assertEqual(Path(result["dest_root"]).name, "smoking_001")
                self.assertEqual(len(captured_dirs), 1)
                self.assertEqual(captured_dirs[0].parent, Path(result["dest_root"]))
                self.assertEqual(captured_dirs[0].name, "source")
            finally:
                if previous is None:
                    os.environ.pop("SEOUL_STUDIO_DATASETS_DIR", None)
                else:
                    os.environ["SEOUL_STUDIO_DATASETS_DIR"] = previous

    def test_video_transfer_uses_videos_generate_and_collision_suffix(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            datasets = Path(tmp) / "datasets"
            source = Path(tmp) / "source.mp4"
            source.write_bytes(b"video")
            (datasets / "vlm" / "videos" / "generate" / "smoking_001").mkdir(parents=True)
            previous = os.environ.get("SEOUL_STUDIO_DATASETS_DIR")
            os.environ["SEOUL_STUDIO_DATASETS_DIR"] = str(datasets)
            try:
                result = send_videos_to_task([(source, "source.mp4")], target="vlm", media_kind="video", frame_interval=30, folder_name="smoking 001")
                self.assertEqual(Path(result["dest_root"]).name, "smoking_001_2")
                self.assertEqual(Path(result["dest_root"]).parent, datasets / "vlm" / "videos" / "generate")
                self.assertTrue((Path(result["dest_root"]) / "source.mp4").is_file())
            finally:
                if previous is None: os.environ.pop("SEOUL_STUDIO_DATASETS_DIR", None)
                else: os.environ["SEOUL_STUDIO_DATASETS_DIR"] = previous



if __name__ == "__main__":
    unittest.main()
