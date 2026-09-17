import json
import subprocess
import threading
import unittest
from unittest.mock import patch
from vlm import prepare as original_prepare,container_path
from detector import Jobs
import test_detector

CATALOG={'advanced_supported':True,'defaults':{'TRAIN_MODALITY':'image','TRAIN_MODE':'lora','IMAGE_MODEL':'./weights/Image','VIDEO_MODEL':'./weights/Video','BOTH_MODEL':'./weights/Both','EPOCHS':'3','BATCH_SIZE':'1','GRAD_ACCUM':'4','DEVICE':'0,1','DATALOADER_NUM_WORKERS':'2','GRADIENT_CHECKPOINTING':'true','VALID_RATIO':'0.1','EVAL_STEPS':'0'},'gpus':[{'id':'0'},{'id':'1'}],'models':[{'path':'/workspace/VLM/weights/'+('Image' if m=='image' else 'Video'),'modality':m} for m in ['image','video','both']],'datasets':[{'path':'/workspace/VLM/data/vlm/'+m+'/20260914/'+f} for m in ['image','video','both'] for f in ['train.json','valid.json']],'automatic':{m:{'train_json':['/workspace/VLM/annotation/vlm/'+m+'/latest/train.json'],'val_json':[]} for m in ['image','video','both']}}
def prepare(params,catalog):
    m=params.get('modality','image')
    return original_prepare({'train_json':'/workspace/VLM/data/vlm/'+m+'/20260914/train.json','val_json':'/workspace/VLM/data/vlm/'+m+'/20260914/valid.json',**params},catalog)

class VlmTests(unittest.TestCase):
    def test_defaults_and_omissions(self):
        r=prepare({'type':'vlm'},CATALOG)
        self.assertEqual(r['effective']['learning_rate'],0.0002)
        self.assertIsNone(r['effective']['max_length'])
        self.assertEqual(r['effective_batch'],8)
        self.assertNotIn('--learning-rate',r['command'])
        self.assertIn('다중 GPU',r['warnings'][-1])
        self.assertEqual(r['sources']['gradient_checkpointing'],'서버 설정')
    def test_advanced_mapping(self):
        p={'type':'vlm','modality':'video','mode':'lora','gpu':'1','lora_rank':8,'lora_dropout':0,'gradient_checkpointing':False,'video_fps':0.5,'video_max_pixels':100352,'eval_steps':-1,'workers':0}
        r=prepare(p,CATALOG)
        for flag in ['--lora-rank 8','--lora-dropout 0','--gradient-checkpointing false','--video-fps 0.5','--eval-steps -1','--workers 0']:self.assertIn(flag,r['command'])
    def test_invalid_values_and_modes(self):
        bad={'epochs':[0,1.5,True],'batch':[0],'gradient_accumulation':[0],'learning_rate':[0,-1,float('nan')],'max_length':[0],'max_samples':[0],'workers':[-1],'lora_rank':[0],'lora_alpha':[0],'lora_dropout':[-1,1],'video_fps':[0],'validation_ratio':[0,1],'gpu':['2','0,0','0;id'],'resume':[True],'name':['x$(id)'],'gradient_checkpointing':['false']}
        for key,values in bad.items():
            for value in values:
                with self.subTest(key=key,value=value),self.assertRaises(ValueError):prepare({'type':'vlm',key:value},CATALOG)
        with self.assertRaises(ValueError):prepare({'type':'vlm','mode':'full','lora_rank':16},CATALOG)
        with self.assertRaises(ValueError):prepare({'type':'vlm','modality':'image','video_fps':1},CATALOG)
        self.assertEqual(prepare({'type':'vlm','mode':'full'},CATALOG)['effective']['learning_rate'],0.00001)
    def test_paths_and_inventory(self):
        r=prepare({'type':'vlm','train_json':'/home/intellivix/train/VLM/data/vlm/image/20260914/train.json'},CATALOG)
        self.assertIn('--annotation /workspace/VLM/',r['command'])
        for path,kind in [('/etc/passwd','json'),('/workspace/VLM/annotation/vlm/image/train.json','json')]:
            with self.assertRaises(ValueError):prepare({'type':'vlm', 'model' if kind=='model' else 'train_json':path},CATALOG)
        broken=dict(CATALOG,advanced_supported=False)
        with self.assertRaises(RuntimeError):prepare({'type':'vlm'},broken)
    def test_fixed_models_and_generated_pair(self):
        for modality,model in [('image','Image'),('both','Video'),('video','Video')]:
            r=prepare({'type':'vlm','modality':modality,'model':'/workspace/VLM/weights/Both'},CATALOG)
            self.assertEqual(r['params']['model'],'/workspace/VLM/weights/'+model)
            self.assertIn('--model /workspace/VLM/weights/'+model,r['command'])
        with self.assertRaises(ValueError):original_prepare({'type':'vlm'},CATALOG)
        with self.assertRaises(ValueError):prepare({'type':'vlm','val_json':'/workspace/VLM/data/vlm/video/20260914/valid.json'},CATALOG)

    def test_vlm_job_and_stop(self):
        jobs=Jobs()
        with patch('vlm.resources',return_value=CATALOG),patch('detector.ssh_command',return_value=['ssh']),patch.object(jobs,'remote_running',return_value=False),patch('detector.threading.Thread'):
            j=jobs.start({'type':'vlm','gpu':'0','train_json':'/workspace/VLM/data/vlm/image/20260914/train.json','val_json':'/workspace/VLM/data/vlm/image/20260914/valid.json','ui_settings':{'vlm_mode':'lora'}})
        self.assertEqual(j['params']['type'],'vlm')
        self.assertRegex(j['params']['name'], r'^vlm_[0-9]{14}$')
        self.assertIn('--name ' + j['params']['name'], j['command'])
        self.assertEqual(j['effective']['gradient_accumulation'],4)
        with self.assertLogs('detector'):jobs.append(j['id'],'stdout','ClearML URL: http://server/projects/abc/experiments/'+'a'*32+'/output/log\n')
        self.assertEqual(jobs.get(j['id'])['clearml_task_id'],'a'*32)
        with patch.object(jobs,'stop_remote',return_value={'status':'stopped','logs':'done'}) as stop,self.assertLogs('detector'):
            jobs.stop(j['id']);stop.assert_called_once_with('vlm')

class VlmApiTests(unittest.TestCase):
    setUp = test_detector.ApiTests.setUp
    request = test_detector.ApiTests.request
    def test_stop_synchronizes_exact_clearml_task(self):
        from io import BytesIO
        import annotation_api
        result={'status':'stopped','id':'local','clearml_task_id':'a'*32}
        response=BytesIO(json.dumps({'meta':{'result_code':200},'data':{'updated':1}}).encode())
        handler=object.__new__(annotation_api.H);handler.headers={'Cookie':'clearml_token_basic=test-session'}
        with patch('annotation_api.urllib.request.urlopen',return_value=response) as update:
            data=handler.sync_clearml_stopped(result)
        self.assertEqual(data['clearml_status'],'stopped')
        req=update.call_args.args[0]
        self.assertEqual(json.loads(req.data)['task'],'a'*32)
        self.assertTrue(req.full_url.endswith('/tasks.stopped'))

    def test_vlm_preview_and_resources(self):
        with patch('vlm.resources',return_value=CATALOG):
            status,result=self.request('/vlm/preview',{'type':'vlm','epochs':1,'gpu':'0','train_json':'/workspace/VLM/data/vlm/image/20260914/train.json','val_json':'/workspace/VLM/data/vlm/image/20260914/valid.json'})
            self.assertEqual(status,200);self.assertEqual(result['effective']['epochs'],1)
            self.assertEqual(self.request('/vlm/resources')[0],200)
            self.assertEqual(self.request('/vlm/preview',{'type':'vlm','epochs':0})[0],400)
            self.assertEqual(self.request('/vlm/preview',{'type':'vlm'},origin='http://evil')[0],403)
        with patch.object(self.api.JOBS,'stop_remote',return_value={'status':'stopped'}) as stop:
            self.assertEqual(self.request('/stop/vlm',{})[0],200);stop.assert_called_once_with('vlm')
