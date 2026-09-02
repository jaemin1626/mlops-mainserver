#!/usr/bin/env python3
"""Rename ClearML projects to Detector / VLM / Dataset."""
from __future__ import annotations

import os
import shutil
import sys

from apiserver.server import app
from apiserver.bll.project.project_bll import ProjectBLL
from apiserver.database.model.project import Project

COMPANY = "d1bd92a3b039400cbafc60a7a5b1e52b"
FS_ROOT = os.environ.get("CLEARML_FILESERVER_ROOT", "/mnt/fileserver")

# parent first, then dataset children, then experiment projects
PROJECT_RENAMES = [
    ("17fa8c4ebf4c4b5a86e1dde584aec13d", "Dataset"),
    ("4e5758f437464715869d99372bb7ba77", "Dataset/.datasets/Detector"),
    ("c0c6b97643284d92866d8927f71ac7be", "Dataset/.datasets/VLM"),
    ("86c50e61d7284ada9632208d3f86525b", "Detector"),
    ("6f5a3e17612f4825acb578c9522362cc", "VLM"),
]

FS_RENAMES = [
    ("Detector-project", "Detector"),
    ("VLM-project", "VLM"),
    ("Intellivix-Datasets", "Dataset"),
    ("Dataset/.datasets/detector-dataset", "Dataset/.datasets/Detector"),
    ("Dataset/.datasets/vlm-dataset", "Dataset/.datasets/VLM"),
]

# Symlinks so old preview URLs in Elasticsearch keep resolving on fileserver.
FS_LEGACY_SYMLINKS = [
    ("Intellivix-Datasets", "Dataset"),
    ("Dataset/.datasets/detector-dataset", "Detector"),
    ("Dataset/.datasets/vlm-dataset", "VLM"),
]

URI_REPLACEMENTS = [
    ("Detector-project", "Detector"),
    ("VLM-project", "VLM"),
    ("Intellivix-Datasets", "Dataset"),
    ("detector-dataset", "Detector"),
    ("vlm-dataset", "VLM"),
]


def rename_projects(bll: ProjectBLL) -> None:
    for project_id, new_name in PROJECT_RENAMES:
        proj = Project.objects(company=COMPANY, id=project_id).first()
        if not proj:
            print(f"SKIP missing project {project_id}")
            continue
        if proj.name == new_name:
            print(f"OK  {new_name}")
            continue
        print(f"RENAME {proj.name!r} -> {new_name!r}")
        bll.update(company=COMPANY, project_id=project_id, name=new_name)


def rename_fileserver() -> None:
    for old, new in FS_RENAMES:
        src = os.path.join(FS_ROOT, old)
        dst = os.path.join(FS_ROOT, new)
        if not os.path.exists(src):
            print(f"FS SKIP {src}")
            continue
        if os.path.exists(dst):
            print(f"FS OK  {dst}")
            continue
        print(f"FS MV  {old} -> {new}")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(src, dst)

    for link, target in FS_LEGACY_SYMLINKS:
        path = os.path.join(FS_ROOT, link)
        if os.path.lexists(path):
            continue
        rel = os.path.relpath(os.path.join(FS_ROOT, target), os.path.dirname(path))
        print(f"FS LN  {link} -> {target}")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        os.symlink(rel, path)


def patch_model_uris() -> None:
    from apiserver.database.model.model import Model

    updated = 0
    for model in Model.objects(uri__exists=True):
        uri = model.uri or ""
        new_uri = uri
        for old, new in URI_REPLACEMENTS:
            new_uri = new_uri.replace(old, new)
        if new_uri != uri:
            model.update(set__uri=new_uri)
            updated += 1
            print(f"URI {uri} -> {new_uri}")
    print(f"Updated {updated} model uri(s)")


def main() -> int:
    with app.app_context():
        rename_projects(ProjectBLL())
        patch_model_uris()
    rename_fileserver()

    with app.app_context():
        print("Projects:")
        for p in Project.objects(company=COMPANY).order_by("name"):
            print(f"  {p.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
