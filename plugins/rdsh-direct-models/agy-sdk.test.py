"""Authentication preflight with fake SDK modules; no SDK or provider runs."""
import asyncio
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


class AuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='rdsh-agy-auth-test-')
        self.home = Path(self.directory.name)
        self.configurations = []
        configurations = self.configurations

        class Configuration:
            def __init__(self, **values):
                configurations.append(values)

        class Response:
            async def text(self):
                return '{"version":1,"text":"synthetic","toolCalls":[]}'

        class Agent:
            def __init__(self, config):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def chat(self, prompt):
                return Response()

        sdk = types.ModuleType('google.antigravity')
        sdk.Agent = Agent
        sdk.LocalAgentConfig = Configuration
        sdk.CapabilitiesConfig = lambda **values: values
        models = types.ModuleType('google.antigravity.models')
        models.DEFAULT_MODEL = 'synthetic-model'
        self.modules = patch.dict(sys.modules, {'google': types.ModuleType('google'), 'google.antigravity': sdk, 'google.antigravity.models': models})
        self.modules.start()
        spec = importlib.util.spec_from_file_location('rdsh_agy_bridge', Path(__file__).with_name('agy-sdk.py'))
        self.bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.bridge)

    def tearDown(self):
        self.modules.stop()
        self.directory.cleanup()

    def run_bridge(self, authentication, operation='generate'):
        environment = {'HOME': str(self.home), 'USERPROFILE': str(self.home), 'TMPDIR': str(self.home), **authentication}
        previous_cwd = os.getcwd()
        try:
            with patch.dict(os.environ, environment, clear=True):
                return asyncio.run(self.bridge.run({'operation': operation, 'model': 'synthetic-model', 'prompt': 'synthetic prompt'}))
        finally:
            os.chdir(previous_cwd)

    def test_enterprise_selector_reaches_fake_sdk_and_keeps_capabilities_disabled(self):
        for enabled in ['True', 'TRUE', '1']:
            with self.subTest(enabled=enabled):
                result = self.run_bridge({'GOOGLE_GENAI_USE_ENTERPRISE': enabled, 'GOOGLE_CLOUD_PROJECT': 'synthetic-project', 'GOOGLE_CLOUD_LOCATION': 'synthetic-location'})
                self.assertIn('text', result)
                config = self.configurations[-1]
                self.assertEqual(config['tools'], [])
                self.assertEqual(config['capabilities'], {'enabled_tools': [], 'enable_subagents': False})
                self.assertFalse(Path(config['save_dir']).exists())

    def test_disabled_enterprise_selector_still_requires_authentication(self):
        for disabled in ['', 'false', '0']:
            self.assertEqual(self.run_bridge({'GOOGLE_GENAI_USE_ENTERPRISE': disabled}), {'error': 'SDK_AUTH_REQUIRED'})
        self.assertEqual(self.configurations, [])

    def test_existing_key_vertex_and_unauthenticated_discovery_paths_remain(self):
        for authentication in [{'GEMINI_API_KEY': 'synthetic'}, {'GOOGLE_API_KEY': 'synthetic'}, {'GOOGLE_GENAI_USE_VERTEXAI': 'True'}]:
            self.assertIn('text', self.run_bridge(authentication))
        self.assertEqual(self.run_bridge({}, 'discover'), {'models': [{'id': 'synthetic-model', 'name': 'synthetic-model'}]})

    def test_workspace_is_created_beneath_parent_owned_directory(self):
        self.assertIn('text', self.run_bridge({'GEMINI_API_KEY': 'synthetic', 'RDSH_SDK_TMPDIR': str(self.home)}))
        workspace = Path(self.configurations[-1]['save_dir'])
        self.assertEqual(workspace.parent, self.home)
        self.assertFalse(workspace.exists())

    def test_wrapped_daily_quota_is_classified_without_exposing_sdk_stderr(self):
        error = RuntimeError('Harness stderr: 429 RESOURCE_EXHAUSTED quota RequestsPerDay synthetic-secret-value')
        output = io.StringIO()
        with patch.object(self.bridge, 'run', side_effect=error), patch.object(sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(b'{}'))), patch.object(sys, 'stdout', output):
            self.bridge.main()
        result = json.loads(output.getvalue())
        self.assertEqual(result['httpStatus'], 429)
        self.assertEqual(result['quotaScope'], 'daily')
        self.assertNotIn('synthetic-secret-value', output.getvalue())
        self.assertNotIn('stderr', output.getvalue())

    def test_unclassified_error_never_exposes_its_message(self):
        output = io.StringIO()
        with patch.object(self.bridge, 'run', side_effect=RuntimeError('synthetic-secret-value')), patch.object(sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(b'{}'))), patch.object(sys, 'stdout', output):
            self.bridge.main()
        self.assertEqual(json.loads(output.getvalue()), {'error': 'SDK_REQUEST_FAILED', 'exceptionClass': 'RuntimeError'})


if __name__ == '__main__':
    unittest.main()
