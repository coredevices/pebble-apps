import os
import os.path
import json
import shutil
from sh import uglifyjs

top = '.'
out = 'build'

def options(ctx):
    ctx.load('pebble_sdk')
    ctx.add_option('--release', action='store_true', help="Compile for release")

def distclean(ctx):
    ctx.load('pebble_sdk')
    try:
        shutil.rmtree('build')
        shutil.rmtree('src/pkjs/00_generated')
    except OSError as e:
        pass

def configure(ctx):
    """
    This method is used to configure your build. ctx.load(`pebble_sdk`) automatically configures
    a build for each valid platform in `targetPlatforms`. Platform-specific configuration: add your
    change after calling ctx.load('pebble_sdk') and make sure to set the correct environment first.
    Universal configuration: add your change prior to calling ctx.load('pebble_sdk').
    """
    ctx.load('pebble_sdk')


def build(ctx):
    # Generate keys.h
    ctx(rule=generate_keys_h, name='keys.h', source='src/keys.json', target='src/generated/keys.h')

    # Generate keys.js
    ctx(rule=generate_keys_js, name='keys.js', source='src/keys.json', target='../src/pkjs/00_generated/keys.js')

    # Generate appinfo.js — treasuredata.js reads AppInfo.shortName,
    # .versionLabel, .uuid and .debug. Sourced from package.json rather than the
    # SDK's build/appinfo.json, which does not exist yet at this point in the
    # build and made waf fail its dependency scan.
    ctx(rule=generate_appinfo_js, name='appinfo.js', source='package.json', target='../src/pkjs/00_generated/appinfo.js')

    # Run the generators now: the ant_glob below is evaluated while the wscript
    # executes, so without this it cannot see keys.js or appinfo.js on a clean
    # tree and silently drops them from the concatenated bundle.
    ctx.compile()

    ctx.load('pebble_sdk')

    # Concatenated in ant_glob's sorted order, which is what the numeric
    # directory prefixes (00_generated, 01_lib, 02_config, 03_sports) are for:
    # every file shares one global scope, so keys.js has to land before
    # anything referencing TYPE/LEAGUE.
    source_js = ctx.path.ant_glob('src/pkjs/**/*.js', excl=['src/pkjs/*config/%s.js' % ('staging' if ctx.options.release else 'production')])
    target_js = 'pebble-js-app.js'

    # Combine the source JS files into a single JS file.
    ctx(rule=concatenate_js, source=source_js, target=target_js)

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
            ctx.pbl_build(source=ctx.path.ant_glob(['worker_src/c/**/*.c']),
                          target=worker_elf,
                          bin_type='worker')
        else:
            binaries.append({'platform': platform, 'app_elf': app_elf})
    ctx.env = cached_env

    ctx.set_group('bundle')
    # The already-concatenated bundle, not the raw sources: with
    # enableMultiJS false the SDK does not merge anything, it just copies, and
    # warns unless one of these nodes is named pebble-js-app.js.
    ctx.pbl_bundle(binaries=binaries,
                   js=[ctx.path.get_bld().make_node(target_js)])

def generate_appinfo_js(task):
    src = task.inputs[0].abspath()
    target = task.outputs[0].abspath()
    pkg = json.load(open(src))
    pbl = pkg.get('pebble', {})
    name = pbl.get('displayName', pkg.get('name', ''))
    info = {
        'shortName': name,
        'longName': name,
        'companyName': pkg.get('author', ''),
        'versionLabel': pkg.get('version', ''),
        'uuid': pbl.get('uuid', ''),
        # Debug logs analytics to the console instead of POSTing them. Mirrors
        # the staging/production split used for source_js above.
        'debug': not task.generator.bld.options.release,
    }
    f = open(target, 'w')
    f.write("'use strict';\n\n")
    f.write('var AppInfo = ')
    f.write(json.dumps(info, indent=2))
    f.write(';\n')
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
