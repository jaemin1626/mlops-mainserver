import io
import json
import unittest
from unittest.mock import patch,MagicMock
from dataset_registry import Registry,RangeFile
from dataset_api import connect,training_metadata
import test_detector

class DatasetRegistryTests(unittest.TestCase):
    def test_range_reader(self):
        data=b'abcdefghijklmnopqrstuvwxyz';registry=MagicMock()
        def download(uri,headers,limit,require_range):
            bounds=headers['Range'].removeprefix('bytes=').split('-');return data[int(bounds[0]):int(bounds[1])+1]
        registry.download.side_effect=download
        f=RangeFile(registry,'http://files/archive.zip',len(data));f.seek(-3,2);self.assertEqual(f.read(),b'xyz');f.seek(2);self.assertEqual(f.read(4),b'cdef')
    def test_refuse_external_artifact(self):
        with self.assertRaises(ValueError):Registry('test').download('http://other-host/internal')
    def test_version_failure_preserves_parent(self):
        q={'dataset_type':'detector','source_id':'a'*32,'token':'test','selected_folders':['trainset']}
        manifest={'source_node':{'id':'a'*32},'selected_folders':['trainset'],'selected_files':['trainset/1.jpg']}
        registry=MagicMock();registry.get_dataset_version.return_value={'status':'completed','configuration':{}};registry.create_dataset_version.return_value={'id':'b'*32}
        with patch('dataset_api.query',return_value=q),patch('dataset_api.Registry',return_value=registry),patch('dataset_api.remote',side_effect=[manifest,ValueError('upload failed')]),self.assertRaises(ValueError):connect(q,'cookie')
        registry.finalize_dataset_version.assert_not_called();registry.call.assert_called_once_with('tasks.failed',{'task':'b'*32,'force':True,'status_reason':'MLOps Dataset version creation failed; training not started'})
    def test_selection_mismatch_creates_no_version(self):
        q={'dataset_type':'detector','source_id':None,'selected_folders':['one']};manifest={'source_node':None,'selected_folders':['two']}
        with patch('dataset_api.query',return_value=q),patch('dataset_api.remote',return_value=manifest),patch('dataset_api.Registry') as registry,self.assertRaises(ValueError):connect(q,'cookie')
        registry.return_value.create_dataset_version.assert_not_called()

    def test_training_connect_persists_new_branch(self):
        q={'dataset_type':'detector','source_id':'a'*32,'token':'tok','selected_folders':['set'],'selected_files':['set/a.jpg'],'branch_name':'v2','new_branch':True}
        manifest={'source_node':{'id':'a'*32},'selected_folders':['set'],'selected_files':['set/a.jpg'],'dataset_type':'detector'}
        parent={'id':'a'*32,'status':'completed','runtime':{'version':'1.0.0','dataset_branch':'v1'},'configuration':{}}
        registry=MagicMock();registry.get_dataset_version.return_value=parent;registry.state.return_value={};registry.graph.return_value={'branches':['v1']};registry.create_dataset_version.return_value={'id':'b'*32,'version':'1.0.1','parent_id':'a'*32};registry.finalize_dataset_version.return_value={'id':'b'*32,'version':'1.0.1','branch':'v2'}
        with patch('dataset_api.Registry',return_value=registry),patch('dataset_api.remote',side_effect=[manifest,{'artifacts':[],'entries':[],'struct':{},'archive_size':0,'changes':{}}]):
            result=connect(q,'cookie')
        self.assertEqual(registry.finalize_dataset_version.call_args.args[1]['dataset_branch'],'v2')
        self.assertEqual(result['source_node']['branch'],'v2')
    def test_training_rejects_wrong_bundle_paths(self):
        manifest={'bundle':'/workspace/Detector/data/generated/day','generated_files':{'train':'train','valid':'valid','test':'test'}}
        params={'type':'detector','data':'data/wrong.yaml','dataset_token':'day','dataset_manifest':manifest['bundle']+'/manifest.json'}
        with patch('dataset_api.remote',return_value=manifest),self.assertRaises(ValueError):training_metadata(params,'cookie')

class DatasetApiTests(unittest.TestCase):
    setUp=test_detector.ApiTests.setUp
    request=test_detector.ApiTests.request
    def test_tree_and_node_routes(self):
        with patch('dataset_api.remote',return_value={'records':[]}),patch('dataset_registry.Registry.list_dataset_nodes',return_value=[]):
            self.assertEqual(self.request('/datasets/tree?type=detector')[0],200)
            self.assertEqual(self.request('/datasets/nodes?type=vlm')[1],{'nodes':[]})

    def test_graph_branch_and_child_delete_guard(self):
        graph={'dataset_name':'Detector','nodes':[{'id':'a'*32}]}
        with patch('dataset_registry.Registry.graph',return_value=graph):
            self.assertEqual(self.request('/datasets/graph?type=detector')[1],graph)
        with patch('dataset_registry.Registry.create_branch',return_value={'ok':True,'node':{'id':'b'*32}}) as branch:
            status,result=self.request('/datasets/branch',{'dataset_type':'detector','parent_id':'a'*32,'version':'1.1.0','description':'branch'})
            self.assertEqual(status,201);self.assertTrue(result['ok']);branch.assert_called_once()
        child={'id':'b'*32,'version':'1.1.0'}
        with patch('dataset_registry.Registry.children',return_value=[child]),patch('dataset_registry.Registry.call') as call:
            status,result=self.request('/api/v2.13/tasks.delete',{'task':'a'*32})
            self.assertEqual(status,409);self.assertIn('하위 Dataset',result['meta']['result_msg']);call.assert_not_called()
    def test_dataset_origin_and_active_job_guard(self):
        self.assertEqual(self.request('/datasets/prepare',{},origin='http://evil')[0],403)
        with patch.object(self.api.JOBS,'active',return_value=[{'id':'running'}]),patch('dataset_api.remote') as remote:
            self.assertEqual(self.request('/datasets/connect',{'dataset_type':'detector'})[0],409);remote.assert_not_called()

class DatasetBranchTests(unittest.TestCase):
    def test_explicit_version_validation_and_duplicate(self):
        registry=Registry('cookie')
        with patch.object(registry,'list_dataset_versions',return_value=[{'version':'1.1.0'}]):
            with self.assertRaisesRegex(ValueError,'이미 존재'):registry.create_dataset_version('detector',None,{},version='1.1.0')
            with self.assertRaisesRegex(ValueError,'버전은'):registry.create_dataset_version('detector',None,{},version='../bad')

    def test_graph_builds_one_to_many_from_explicit_parent(self):
        registry=Registry('cookie')
        versions=[{'id':'a'*32},{'id':'b'*32},{'id':'c'*32}]
        tasks={
          'a'*32:{'id':'a'*32,'name':'Detector','created':'2026-01-01','last_update':'2026-01-01','status':'completed','comment':'','runtime':{'version':'1.0.0'},'configuration':{}},
          'b'*32:{'id':'b'*32,'name':'Detector','created':'2026-01-02','last_update':'2026-01-02','status':'completed','comment':'','runtime':{'version':'1.0.1','dataset_parent_id':'a'*32},'configuration':{}},
          'c'*32:{'id':'c'*32,'name':'Detector','created':'2026-01-03','last_update':'2026-01-03','status':'completed','comment':'','runtime':{'version':'1.1.0','dataset_parent_id':'a'*32},'configuration':{}}
        }
        with patch.object(registry,'list_dataset_versions',return_value=versions),patch.object(registry,'get_dataset_version',side_effect=lambda kind,id:tasks[id]):
            graph=registry.graph('detector')
        self.assertEqual({(e['source'],e['target']) for e in graph['edges']},{('a'*32,'b'*32),('a'*32,'c'*32)})
        self.assertEqual({x['version'] for x in next(n for n in graph['nodes'] if n['id']=='a'*32)['children']},{'1.0.1','1.1.0'})
        self.assertTrue(next(n for n in graph['nodes'] if n['id']=='c'*32)['latest'])

    def test_branch_copies_metadata_without_data_archive_upload(self):
        registry=Registry('cookie');parent_id='a'*32;child_id='b'*32
        parent={'id':parent_id,'name':'Detector','status':'completed','created':'x','runtime':{'version':'1.0.0','ds_total_size_compressed':20},'configuration':{'Dataset Struct':{'value':json.dumps({'0':{'job_id':parent_id}})}}}
        state={'id':parent_id,'dataset_file_entries':[{'relative_path':'detector/a.jpg','size':10,'hash':'h'}],'dataset_link_entries':[],'dependency_graph':{parent_id:[]},'dependency_chunk_lookup':{parent_id:0},'total_size':10}
        manifest={'dataset_type':'detector','selected_folders':['x'],'file_count':1}
        with patch.object(registry,'get_dataset_version',return_value=parent),patch.object(registry,'state',return_value=state),patch.object(registry,'get_dataset_manifest',return_value=manifest),patch.object(registry,'create_dataset_version',return_value={'id':child_id,'version':'1.1.0','parent_id':parent_id}),patch.object(registry,'upload_bytes',side_effect=lambda task,name,key,*a,**k:{'key':key}) as upload_bytes,patch.object(registry,'upload_dataset_files') as upload,patch.object(registry,'finalize_dataset_version',return_value={'id':child_id}) as finalize,patch.object(registry,'graph',return_value={'nodes':[]}):
            result=registry.create_branch('detector',parent_id,'1.1.0','branch')
        self.assertEqual([a.args[2] for a in upload_bytes.call_args_list],['state','manifest'])
        self.assertEqual(finalize.call_args.args[3],parent)
        self.assertTrue(result['ok'])

