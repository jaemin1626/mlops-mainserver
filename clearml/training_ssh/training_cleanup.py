"""Delete the remote training output paired with a deleted ClearML training Task."""
import json
import re
import shlex
from client import ssh_command, TRAINING_ROOT

PROJECT_ROOTS = {
    'Detector': [TRAINING_ROOT + '/Detector/runs/Detector'],
    'VLM': [
        TRAINING_ROOT + '/VLM/runs/train/image',
        TRAINING_ROOT + '/VLM/runs/train/video',
        TRAINING_ROOT + '/VLM/runs/train/both',
    ],
}

# VLM ClearML Task 이름은 "{대상}_{타임스탬프}"(예: Image_202609160950)로 자동 생성되지만,
# 실제 학습 서버의 결과 폴더는 대상별 하위 폴더(runs/train/image 등)에 타임스탬프만으로
# 저장된다(예: 202609160950, 202609160950_plots). 접두어를 제거한 이름도 후보로 함께 넣지
# 않으면 삭제 대상 경로가 하나도 존재하지 않아 아무것도 지워지지 않는다.
_VLM_MODALITY_PREFIXES = ('image_', 'video_', 'both_', 'vlm_')

def remote_delete_command(project_name, task_name):
    if project_name not in PROJECT_ROOTS:
        return None
    if not isinstance(task_name, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', task_name):
        raise ValueError('학습 Task 이름이 안전한 폴더 이름 형식이 아닙니다.')
    roots = PROJECT_ROOTS[project_name]
    if project_name != 'VLM':
        names = [task_name]
    else:
        # 원래 Task 이름과, 대상 접두어를 제거한 실제 폴더 이름 둘 다 시도한다.
        # 각 이름에 대해 결과 폴더(name)와 시각화 자료 형제 폴더(name_plots)를 함께 정리 대상에 넣는다.
        base_names = {task_name}
        lowered_task_name = task_name.lower()
        for prefix in _VLM_MODALITY_PREFIXES:
            if lowered_task_name.startswith(prefix):
                base_names.add(task_name[len(prefix):])
                break
        names = [n for base in base_names for n in (base, base + '_plots')]
    code = (
        "import json,pathlib,subprocess,sys;"
        "roots=[pathlib.Path(x).resolve() for x in json.loads(sys.argv[1])];"
        "names=json.loads(sys.argv[2]);removed=[];"
        "[(subprocess.run(['docker','run','--rm','--network','none','-v',str(r)+':/cleanup:rw','alpine:latest','sh','-c','test ! -d \"/cleanup/$1\" || rm -rf -- \"/cleanup/$1\"','sh',name],check=True),removed.append(str(p))) "
        "for r in roots for name in names for p in [r/name] if p.exists() and p.is_dir() and p.resolve().parent==r];"
        "print(json.dumps({'removed':removed},ensure_ascii=False))"
    )
    return ssh_command(shlex.join(['python3', '-c', code, json.dumps(roots), json.dumps(names)]))
