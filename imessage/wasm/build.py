#!/usr/bin/env python3
"""Rebuild the committed interpreter using Emscripten 4.0.11 and pinned Blink."""
from pathlib import Path
import concurrent.futures
import hashlib
import json
import subprocess
import tempfile
import sys

HERE = Path(__file__).resolve().parent
PUBLIC = HERE.parents[2]
INTERPRETER = PUBLIC / 'x86executor-interpreter'
SOURCE = INTERPRETER / 'src/main/c/third_party/blink'
COMMIT = 'f006a4fc6f9b8de9272504fdff0dbbe5ce5dc580'
LEGACY = '--legacy' in sys.argv
FLAGS = ['-O3', '-flto'] + ([] if LEGACY else ['-sSUPPORT_LONGJMP=wasm'])
OUTPUT = HERE.parent / ('src/runtime/generated/blink-wasm-legacy.js' if LEGACY else 'src/runtime/generated/blink-wasm.js')
if '4.0.11' not in subprocess.check_output(['emcc', '--version'], text=True).splitlines()[0]:
    raise SystemExit('Use Emscripten 4.0.11 to reproduce this artifact')
if subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip() != COMMIT:
    raise SystemExit('Initialize the pinned Blink submodule')
with tempfile.TemporaryDirectory(prefix='chat-wasm-') as directory:
    work = Path(directory)
    source = work / 'blink'
    source.mkdir()
    archive = subprocess.check_output(['git', '-C', str(SOURCE), 'archive', COMMIT])
    subprocess.run(['tar', '-x', '-C', str(source)], input=archive, check=True)
    with (INTERPRETER / 'src/main/c/patches/blink-guest-memory-protection.patch').open() as patch:
        subprocess.run(['patch', '-s', '-F', '0', '-d', str(source), '-p1'], stdin=patch, check=True)
    config = (INTERPRETER / 'src/main/c/apple/config.h').read_text()
    (source / 'config.h').write_text(config.replace('#define HAVE_SA_LEN', '').replace('#define HAVE_INT128', ''))
    members = (INTERPRETER / 'src/main/c/apple/blink-members.txt').read_text().split() + ['pte32']
    files = [source / 'blink' / (name + '.c') for name in members]
    files += [INTERPRETER / 'src/main/c/pebble_x86_executor_blink.c', HERE / 'entropy.c']
    def compile_file(file):
        obj = work / (file.stem + '.o')
        subprocess.run(['emcc', '-std=c11', *FLAGS, '-D_GNU_SOURCE', '-DPEBBLE_BLINK_EMBEDDED=1',
                        '-Dexit=pebble_blink_exit', '-D_Exit=pebble_blink_exit', '-D_exit=pebble_blink_exit',
                        '-ffile-prefix-map=' + str(work) + '=/chat-wasm', '-iquote', str(source),
                        '-I' + str(PUBLIC / 'x86executor-native/src/main/cpp/include'),
                        '-c', str(file), '-o', str(obj)], check=True)
        return str(obj)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        objects = list(pool.map(compile_file, files))
    names = ['create', 'destroy', 'map', 'unmap', 'protect', 'read', 'write', 'read_registers',
             'write_registers', 'set_exits', 'run', 'last_backend_error']
    subprocess.run(['emcc', *objects, *FLAGS, '-sWASM_BIGINT=1', '-sALLOW_MEMORY_GROWTH=1',
                    '-sMAXIMUM_MEMORY=268435456', '-sSTACK_SIZE=1048576', '-sWASM_ASYNC_COMPILATION=0',
                    '-sSINGLE_FILE=1', '-sMODULARIZE=1', '-sEXPORT_NAME=createBlinkWasm', '-sENVIRONMENT=shell',
                    '-sFILESYSTEM=0', '--pre-js', str(HERE / 'pre.js'), '-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32',
                    '-sEXPORTED_FUNCTIONS=' + json.dumps(['_malloc', '_free'] + ['_pebble_x86_' + n for n in names]),
                    '-o', str(OUTPUT)], check=True)
    if '--test' in sys.argv:
        test_source = work / 'conformance.c'
        test_source.write_text((INTERPRETER / 'src/test/c/pebble_x86_executor_blink_test.c').read_text().replace(
            '    test_guest_fault_preserves_host_signal_mask();',
            '    /* POSIX signal masks are not available in Wasm. */'))
        test_object = work / 'conformance.o'
        subprocess.run(['emcc', *FLAGS, '-D_GNU_SOURCE', '-DPEBBLE_BLINK_TESTING',
                        '-I' + str(PUBLIC / 'x86executor-native/src/main/cpp/include'),
                        '-c', str(test_source), '-o', str(test_object)], check=True)
        test_output = work / 'conformance.cjs'
        subprocess.run(['emcc', *[o for o in objects if not o.endswith('pebble_x86_executor_blink.o')],
                        str(test_object), str(INTERPRETER / 'src/main/c/pebble_x86_executor_blink.c'),
                        *FLAGS, '-D_GNU_SOURCE', '-DPEBBLE_BLINK_TESTING', '-DPEBBLE_BLINK_EMBEDDED=1',
                        '-Dexit=pebble_blink_exit', '-D_Exit=pebble_blink_exit', '-D_exit=pebble_blink_exit',
                        '-iquote', str(source), '-I' + str(PUBLIC / 'x86executor-native/src/main/cpp/include'),
                        '-sWASM_BIGINT=1', '-sALLOW_MEMORY_GROWTH=1', '-sMAXIMUM_MEMORY=268435456',
                        '-sSTACK_SIZE=1048576', '-sWASM_ASYNC_COMPILATION=0', '-sSINGLE_FILE=1',
                        '-sMODULARIZE=1', '-sENVIRONMENT=shell', '-sFILESYSTEM=0',
                        '--pre-js', str(HERE / 'pre.js'), '-o', str(test_output)], check=True)
        subprocess.run(['node', '-e', "require(process.argv[1])()", str(test_output)], check=True)

print('SHA256', hashlib.sha256(OUTPUT.read_bytes()).hexdigest())
inputs = [Path(__file__).resolve(), HERE / 'entropy.c', HERE / 'pre.js',
          INTERPRETER / 'src/main/c/pebble_x86_executor_blink.c',
          INTERPRETER / 'src/main/c/apple/config.h', INTERPRETER / 'src/main/c/apple/blink-members.txt',
          INTERPRETER / 'src/main/c/patches/blink-guest-memory-protection.patch',
          PUBLIC / 'x86executor-native/src/main/cpp/include/pebble_x86_executor.h']
manifest = {'blinkCommit': COMMIT, 'emscripten': '4.0.11',
            'inputs': {str(f.relative_to(PUBLIC)): hashlib.sha256(f.read_bytes()).hexdigest() for f in inputs},
            'outputs': {f.name: hashlib.sha256(f.read_bytes()).hexdigest()
                        for f in OUTPUT.parent.glob('blink-wasm*.js')}}
(HERE / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')

if not LEGACY:
    subprocess.run([sys.executable, str(Path(__file__).resolve()), '--legacy'] + (['--test'] if '--test' in sys.argv else []), check=True)
