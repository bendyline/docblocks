"""Compare every web asset against the actual native archive; never trust a sync log."""
import hashlib
import json
import pathlib
import plistlib
import sys
import zipfile

platform, artifact, web_dir, version, build_number = sys.argv[1:]
web = pathlib.Path(web_dir)
expected = {str(p.relative_to(web)): hashlib.sha256(p.read_bytes()).hexdigest() for p in web.rglob('*') if p.is_file()}
assert expected and 'index.html' in expected and 'THIRD_PARTY_NOTICES.txt' in expected
if platform == 'ios':
    app = pathlib.Path(artifact) / 'Products/Applications/App.app'
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    assert info['CFBundleIdentifier'] == 'com.bendyline.docblocks.mobile'
    assert info['CFBundleShortVersionString'] == version and info['CFBundleVersion'] == build_number
    privacy = plistlib.loads((app / 'PrivacyInfo.xcprivacy').read_bytes())
    assert {'NSPrivacyAccessedAPICategoryDiskSpace', 'NSPrivacyAccessedAPICategorySystemBootTime'} <= {item['NSPrivacyAccessedAPIType'] for item in privacy['NSPrivacyAccessedAPITypes']}
    actual = {str(p.relative_to(app / 'public')): hashlib.sha256(p.read_bytes()).hexdigest() for p in (app / 'public').rglob('*') if p.is_file()}
    config = json.loads((app / 'capacitor.config.json').read_text())
    assert 'GezelRuntimePlugin' in config['packageClassList'], 'Missing native AI plugin'
    assert b'llama_model_load_from_file_impl' in (app / 'App').read_bytes(), 'Missing linked inference engine'
    assert b'DocBlocksAiSmoke' not in (app / 'App').read_bytes(), 'Test runner shipped in release'
else:
    with zipfile.ZipFile(artifact) as archive:
        prefix = 'base/assets/' if artifact.endswith('.aab') else 'assets/'
        actual = {name.removeprefix(prefix + 'public/'): hashlib.sha256(archive.read(name)).hexdigest() for name in archive.namelist() if name.startswith(prefix + 'public/') and not name.endswith('/')}
        config = json.loads(archive.read(prefix + 'capacitor.config.json'))
        for name in archive.namelist():
            if name.endswith('.dex'):
                assert b'ContractDocumentsProvider' not in archive.read(name), 'Test provider shipped in release'
        plugins = json.loads(archive.read(prefix + 'capacitor.plugins.json'))
        assert any(p['pkg'] == '@bendyline/gezel-capacitor' for p in plugins)
        assert not any(name.endswith('mobile-ai-fixture.gguf') for name in archive.namelist())
        native_prefix = 'base/lib/arm64-v8a/' if artifact.endswith('.aab') else 'lib/arm64-v8a/'
        for library in ['libgezel-llama.so', 'libgezel_llama_jni.so', 'libllama.so']:
            assert native_prefix + library in archive.namelist(), 'Missing packaged inference engine'
        manifest = archive.read('base/manifest/AndroidManifest.xml' if artifact.endswith('.aab') else 'AndroidManifest.xml')
        # AAPT binary XML and bundle protobuf retain string values in UTF-8 or UTF-16.
        for forbidden in ['MANAGE_EXTERNAL_STORAGE', 'READ_EXTERNAL_STORAGE', 'WRITE_EXTERNAL_STORAGE', 'com.bendyline.docblocks.mobile.tests']:
            assert forbidden.encode() not in manifest and forbidden.encode('utf-16le') not in manifest, forbidden
assert config['appId'] == 'com.bendyline.docblocks.mobile'
assert 'url' not in config.get('server', {}) and not config.get('server', {}).get('allowNavigation')
assert all(actual.get(name) == digest for name, digest in expected.items()), 'Native web payload is stale or incomplete'
assert not any('ffmpeg-core' in name for name in actual)
assert not any(name.endswith(('ai-smoke.js', 'mobile-ai-fixture.gguf')) for name in actual), 'AI test assets shipped in release'
print(json.dumps({'platform': platform, 'webFilesVerified': len(expected), 'artifact': artifact}))
