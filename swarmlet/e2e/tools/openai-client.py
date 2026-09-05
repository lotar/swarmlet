#!/usr/bin/env python3
"""Validate a Swarmlet endpoint with the official OpenAI SDK and strict response schemas.

Run: uv run --with openai==3.8.0 python e2e/tools/openai-client.py
For a keyed public URL, pass --base-url and --key-env naming an existing environment variable.
"""
import argparse
import json
import os

import openai
from openai import OpenAI


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', default='http://127.0.0.1:47800/v1')
    parser.add_argument('--key-env', help='Environment variable holding the inference API key; defaults to local')
    parser.add_argument('--model', default='qwen3.5-2b')
    parser.add_argument('--expect-route', choices=['local', 'mesh'])
    args = parser.parse_args()
    key = os.environ.get(args.key_env, '') if args.key_env else 'local'
    if not key:
        parser.error('the requested API-key environment variable is empty')
    with OpenAI(base_url=args.base_url, api_key=key, max_retries=0, timeout=90,
                _strict_response_validation=True) as client:
        catalog = client.models.list()
        assert any(model.id == args.model for model in catalog.data), 'requested model is not ready'
        response = client.chat.completions.with_raw_response.create(
            model=args.model, messages=[{'role': 'user', 'content': 'Say exactly: SDK works.'}],
            stream=True, max_tokens=32, extra_body={'chat_template_kwargs': {'enable_thinking': False}},
        )
        route = response.headers.get('x-swarmlet-route')
        if args.expect_route:
            assert route == args.expect_route, f'expected {args.expect_route}, received {route}'
        with response.parse() as stream:
            content = ''.join(chunk.choices[0].delta.content or '' for chunk in stream if chunk.choices)
        assert content.strip(), 'empty assistant reply'
        print(json.dumps({'sdk': openai.__version__, 'model': args.model, 'route': route, 'reply': content}))


if __name__ == '__main__':
    main()
