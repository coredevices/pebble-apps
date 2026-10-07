import os
import os.path
import json
import shutil

top = '.'
out = 'build'

def options(ctx):
    ctx.load('pebble_sdk')

def configure(ctx):
    """
    This method is used to configure your build. ctx.load(`pebble_sdk`) automatically configures
    a build for each valid platform in `targetPlatforms`. Platform-specific configuration: add your
    change after calling ctx.load('pebble_sdk') and make sure to set the correct environment first.
    Universal configuration: add your change prior to calling ctx.load('pebble_sdk').
    """
    ctx.load('pebble_sdk')

def distclean(ctx):
    ctx.load('pebble_sdk')
    try:
        shutil.rmtree('build')
    except OSError as e:
        pass
    try:
        shutil.rmtree('src/pkjs/generated')
    except OSError as e:
        pass


def build(ctx):
    # Generate keys.h
    ctx(rule=generate_keys_h, name='keys.h', source='src/keys.json', target='src/generated/keys.h')

    # Generate keys.js
    ctx(rule=generate_keys_js, name='keys.js', source='src/keys.json', target='../src/pkjs/generated/keys.js')

    ctx.compile()

    ctx.load('pebble_sdk')

    build_worker = os.path.exists('worker_src')
    binaries = []

    cached_env = ctx.env
    for platform in ctx.env.TARGET_PLATFORMS:
        ctx.env = ctx.all_envs[platform]
        ctx.set_group(ctx.env.PLATFORM_NAME)
        app_elf = '{}/pebble-app.elf'.format(ctx.env.BUILD_DIR)
        ctx.pbl_build(source=ctx.path.ant_glob('src/**/*.c'), target=app_elf, bin_type='app')

        if build_worker:
            worker_elf = '{}/pebble-worker.elf'.format(ctx.env.BUILD_DIR)
            binaries.append({'platform': platform, 'app_elf': app_elf, 'worker_elf': worker_elf})
            ctx.pbl_build(source=ctx.path.ant_glob('worker_src/c/**/*.c'),
                          target=worker_elf,
                          bin_type='worker')
        else:
            binaries.append({'platform': platform, 'app_elf': app_elf})
    ctx.env = cached_env

    ctx.set_group('bundle')
    ctx.pbl_bundle(binaries=binaries,
                   js=ctx.path.ant_glob(['src/pkjs/**/*.js',
                                         'src/pkjs/**/*.json',
                                         'src/common/**/*.js']),
                   js_entry_file='src/pkjs/index.js')

def generate_keys_h(task):
    src = task.inputs[0].abspath()
    target = task.outputs[0].abspath()
    keys = json.load(open(src))
    f = open(target, 'w')
    f.write('#pragma once\n')
    for key in keys:
        f.write('\nenum {\n')
        for key2 in keys[key]:
            f.write('  KEY_{0}_{1},\n'.format(key, key2))
        f.write('};\n')
    f.close()

def generate_keys_js(task):
    src = task.inputs[0].abspath()
    target = task.outputs[0].abspath()
    keys = json.load(open(src))
    enums = {group: {name: i for i, name in enumerate(names)}
             for group, names in keys.items()}
    with open(target, 'w') as f:
        f.write("'use strict';\n\n")
        f.write('module.exports = ')
        f.write(json.dumps(enums, indent=2))
        f.write(';\n')