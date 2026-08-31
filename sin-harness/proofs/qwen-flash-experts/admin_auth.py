#!/usr/bin/env python3
"""Test-only Qwen service administration authorization."""
import hmac
def admin_status(path,configured_token,authorization):
 if not (path.startswith('/admin/') or path=='/shutdown'):return None
 if not configured_token:return 404
 expected=f'Bearer {configured_token}'
 return 200 if isinstance(authorization,str) and hmac.compare_digest(authorization,expected) else 401
def selftest():
 token='a'*64;assert admin_status('/v1/ffn',token,None) is None;assert admin_status('/shutdown',None,None)==404;assert admin_status('/shutdown',token,None)==401;assert admin_status('/admin/stop-owner',token,'Bearer wrong')==401;assert admin_status('/admin/stop-owner',token,f'Bearer {token}')==200;return {'verified':True,'disabled404':True,'wrongToken401':True,'validToken200':True}
if __name__=='__main__':
 import json;print('RESULT_JSON='+json.dumps(selftest(),separators=(',',':')))
