import os
import json
import shutil
from sh import uglifyjs

top = '.'
out = 'build'

def options(ctx):
    ctx.load('pebble_sdk')
    ctx.add_option('--release', action='store_true', help="Compile for release")

def configure(ctx):
    ctx.load('pebble_sdk')

def distclean(ctx):
    ctx.load('pebble_sdk')
    try:
        shutil.rmtree('build')
        shutil.rmtree('src/js/00_generated')
    except OSError as e:
        pass

def build(ctx):
    # Generate appinfo.h
    ctx(rule=generate_appinfo_h, name='appinfo.h', source='appinfo.json', target='src/generated/appinfo.h')

    # Generate keys.h
    ctx(rule=generate_keys_h, name='keys.h', source='src/keys.json', target='src/generated/keys.h')

    # Generate appinfo.js
    ctx(rule=generate_appinfo_js, name='appinfo.js', source='appinfo.json', target='../src/js/00_generated/appinfo.js')

    # Generate keys.js
    ctx(rule=generate_keys_js, name='keys.js', source='src/keys.json', target='../src/js/00_generated/keys.js')

    # Start compiling so we generate files before building
    ctx.compile()

    # Load Pebble SDK
    ctx.load('pebble_sdk')

    source_js = ctx.path.ant_glob('src/js/**/*.js', excl=['src/js/*config/%s.js' % ('staging' if ctx.options.release else 'production')])
    target_js = 'pebble-js-app.js'

    # Combine the source JS files into a single JS file.
    ctx(rule=concatenate_js, source=source_js, target=target_js)

    # Build and bundle the Pebble app.
    binaries = []

    for p in ctx.env.TARGET_PLATFORMS:
        ctx.set_env(ctx.all_envs[p])
        ctx.set_group(ctx.env.PLATFORM_NAME)
        app_elf = '{}/pebble-app.elf'.format(ctx.env.BUILD_DIR)
        ctx.pbl_program(source=ctx.path.ant_glob('src/**/*.c'), includes='src/libs', target=app_elf)
        binaries.append({'platform': p, 'app_elf': app_elf})

    ctx.set_group('bundle')
    ctx.pbl_bundle(binaries=binaries, js=target_js)

def generate_appinfo_h(task):
    src = task.inputs[0].abspath()
    target = task.outputs[0].abspath()
    appinfo = json.load(open(src))
    f = open(target, 'w')
    f.write('#pragma once\n\n')
    f.write('#define DEBUG {0}\n'.format('true' if appinfo['debug'] else 'false'))
    f.write('#define VERSION_LABEL "{0}"\n'.format(appinfo['versionLabel']))
    f.write('#define UUID "{0}"\n'.format(appinfo['uuid']))
    for key in appinfo['appKeys']:
        f.write('#define APP_KEY_{0} {1}\n'.format(key.upper(), appinfo['appKeys'][key]))
    f.close()

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

def generate_appinfo_js(task):
    src = task.inputs[0].abspath()
    target = task.outputs[0].abspath()
    data = open(src).read().strip()
    f = open(target, 'w')
    f.write("'use strict';\n\n");
    f.write('var AppInfo = ')
    f.write(data.replace('"', '\''));
    f.write(';\n')
    f.close()

def generate_keys_js(task):
    src = task.inputs[0].abspath()
    target = task.outputs[0].abspath()
    keys = json.load(open(src))
    f = open(target, 'w')
    f.write("'use strict';\n\n");
    for key in keys:
        f.write('var {0} = {{'.format(key))
        i = 0
        for key2 in keys[key]:
            if i > 0: f.write(',')
            f.write('\n  {0}: {1}'.format(key2, i))
            i += 1
        f.write('\n};\n')
    f.close()

def concatenate_js(task):
    inputs = (input.abspath() for input in task.inputs)
    uglifyjs(*inputs, o=task.outputs[0].abspath(), m=True)
