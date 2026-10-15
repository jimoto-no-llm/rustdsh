"""One fresh official SDK turn; no tools, filesystem skills, MCP or subagents."""
import asyncio
import contextlib
import json
import logging
import os
import sys
import tempfile

LIMIT = 8 * 1024 * 1024

async def run(payload):
    from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig
    from google.antigravity.models import DEFAULT_MODEL
    if payload.get('operation') == 'discover':
        return {'models': [{'id': DEFAULT_MODEL, 'name': DEFAULT_MODEL}]}
    if not (os.environ.get('GEMINI_API_KEY') or os.environ.get('GOOGLE_API_KEY') or os.environ.get('GOOGLE_GENAI_USE_VERTEXAI', '').lower() in ('1', 'true')):
        return {'error': 'SDK_AUTH_REQUIRED'}
    prompt = payload.get('prompt')
    if not isinstance(prompt, str) or not prompt:
        return {'error': 'INVALID_REQUEST'}
    with tempfile.TemporaryDirectory(prefix='rdsh-agy-sdk-') as workspace:
        os.chdir(workspace)
        config = LocalAgentConfig(
            model=payload.get('model') or DEFAULT_MODEL,
            capabilities=CapabilitiesConfig(enabled_tools=[], enable_subagents=False),
            tools=[], mcp_servers=[], skills_paths=[], inline_skills=[],
            subagents=[], hooks=[], triggers=[], policies=[],
            workspaces=[workspace], save_dir=workspace,
            app_data_dir=workspace,
            system_instructions='Return exactly one JSON envelope as requested. Tools are descriptions only; never execute them.',
        )
        # A fresh Agent is intentionally created for every call; DSH owns history.
        async with Agent(config) as agent:
            response = await agent.chat(prompt)
            text = await response.text()
            if not isinstance(text, str) or len(text.encode('utf8')) > LIMIT:
                return {'error': 'INVALID_RESPONSE'}
            return {'text': text}

def main():
    logging.disable(logging.CRITICAL)
    raw = sys.stdin.buffer.read(LIMIT + 1)
    if len(raw) > LIMIT:
        result = {'error': 'INPUT_LIMIT'}
    else:
        try:
            payload = json.loads(raw)
            # SDK output must never corrupt the machine protocol or expose auth.
            with contextlib.redirect_stdout(open(os.devnull, 'w')), contextlib.redirect_stderr(open(os.devnull, 'w')):
                result = asyncio.run(run(payload))
        except ModuleNotFoundError:
            result = {'error': 'SDK_NOT_INSTALLED'}
        except Exception as error:
            name = type(error).__name__
            result = {'error': 'SDK_REQUEST_FAILED', 'exceptionClass': name if name.isascii() and name.isidentifier() and len(name) <= 64 else 'Exception'}
            status = getattr(error, 'status_code', None)
            if status is None:
                status = getattr(getattr(error, 'response', None), 'status_code', None)
            if status is None:
                status = getattr(error, 'code', None)
            if isinstance(status, int) and not isinstance(status, bool) and 400 <= status <= 599:
                result['httpStatus'] = status
    sys.stdout.write(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
