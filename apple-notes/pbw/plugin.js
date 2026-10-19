(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __defProps = Object.defineProperties;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropSymbols = Object.getOwnPropertySymbols;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __propIsEnum = Object.prototype.propertyIsEnumerable;
  var __knownSymbol = (name, symbol2) => (symbol2 = Symbol[name]) ? symbol2 : Symbol.for("Symbol." + name);
  var __typeError = (msg) => {
    throw TypeError(msg);
  };
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __spreadValues = (a, b) => {
    for (var prop in b || (b = {}))
      if (__hasOwnProp.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    if (__getOwnPropSymbols)
      for (var prop of __getOwnPropSymbols(b)) {
        if (__propIsEnum.call(b, prop))
          __defNormalProp(a, prop, b[prop]);
      }
    return a;
  };
  var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
  var __esm = (fn, res) => function __init() {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  };
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
  var __await = function(promise, isYieldStar) {
    this[0] = promise;
    this[1] = isYieldStar;
  };
  var __yieldStar = (value) => {
    var obj = value[__knownSymbol("asyncIterator")], isAwait = false, method, it = {};
    if (obj == null) {
      obj = value[__knownSymbol("iterator")]();
      method = (k) => it[k] = (x) => obj[k](x);
    } else {
      obj = obj.call(value);
      method = (k) => it[k] = (v) => {
        if (isAwait) {
          isAwait = false;
          if (k === "throw") throw v;
          return v;
        }
        isAwait = true;
        return {
          done: false,
          value: new __await(new Promise((resolve) => {
            var x = obj[k](v);
            if (!(x instanceof Object)) __typeError("Object expected");
            resolve(x);
          }), 1)
        };
      };
    }
    return it[__knownSymbol("iterator")] = () => it, method("next"), "throw" in obj ? method("throw") : it.throw = (x) => {
      throw x;
    }, "return" in obj && method("return"), it;
  };

  // src/textEncodingPolyfill.js
  var require_textEncodingPolyfill = __commonJS({
    "src/textEncodingPolyfill.js"() {
      (function installTextEncoding(global) {
        if (typeof global.TextEncoder !== "function") {
          global.TextEncoder = function TextEncoder2() {
          };
          global.TextEncoder.prototype.encode = function encode(value) {
            var text = String(value === void 0 ? "" : value);
            var bytes = [];
            for (var i = 0; i < text.length; i++) {
              var code = text.charCodeAt(i);
              if (code >= 55296 && code <= 56319 && i + 1 < text.length) {
                var low = text.charCodeAt(i + 1);
                if (low >= 56320 && low <= 57343) {
                  code = 65536 + (code - 55296 << 10) + low - 56320;
                  i++;
                } else {
                  code = 65533;
                }
              } else if (code >= 56320 && code <= 57343) {
                code = 65533;
              }
              if (code < 128) bytes.push(code);
              else if (code < 2048) bytes.push(192 | code >> 6, 128 | code & 63);
              else if (code < 65536) {
                bytes.push(224 | code >> 12, 128 | code >> 6 & 63, 128 | code & 63);
              } else {
                bytes.push(240 | code >> 18, 128 | code >> 12 & 63, 128 | code >> 6 & 63, 128 | code & 63);
              }
            }
            return new Uint8Array(bytes);
          };
        }
        if (typeof global.TextDecoder !== "function") {
          global.TextDecoder = function TextDecoder2(label) {
            if (label && !/^utf-?8$/i.test(String(label))) throw new RangeError("Only UTF-8 is supported.");
          };
          global.TextDecoder.prototype.decode = function decode(input) {
            var bytes = input ? new Uint8Array(input.buffer || input, input.byteOffset || 0, input.byteLength) : new Uint8Array(0);
            var out = "";
            for (var i = 0; i < bytes.length; ) {
              var first = bytes[i++];
              var code;
              var needed;
              var minimum;
              if (first < 128) {
                code = first;
                needed = 0;
                minimum = 0;
              } else if (first >= 194 && first <= 223) {
                code = first & 31;
                needed = 1;
                minimum = 128;
              } else if (first >= 224 && first <= 239) {
                code = first & 15;
                needed = 2;
                minimum = 2048;
              } else if (first >= 240 && first <= 244) {
                code = first & 7;
                needed = 3;
                minimum = 65536;
              } else {
                out += "\uFFFD";
                continue;
              }
              var start = i;
              var valid = true;
              for (var offset = 0; offset < needed; offset++) {
                var next = bytes[i + offset];
                if (next === void 0 || (next & 192) !== 128) {
                  valid = false;
                  break;
                }
                code = code << 6 | next & 63;
              }
              if (!valid) {
                out += "\uFFFD";
                i = start;
                continue;
              }
              i += needed;
              if (code < minimum || code > 1114111 || code >= 55296 && code <= 57343) {
                out += "\uFFFD";
              } else if (code <= 65535) {
                out += String.fromCharCode(code);
              } else {
                code -= 65536;
                out += String.fromCharCode(55296 + (code >> 10), 56320 + (code & 1023));
              }
            }
            return out;
          };
        }
      })(globalThis);
    }
  });

  // node_modules/pako/dist/pako.mjs
  function zero$1(buf) {
    let len = buf.length;
    while (--len >= 0) buf[len] = 0;
  }
  function inflate_fast(strm, start) {
    let _in;
    let last;
    let _out;
    let beg;
    let end;
    let dmax;
    let wsize;
    let whave;
    let wnext;
    let s_window;
    let hold;
    let bits;
    let lcode;
    let dcode;
    let lmask;
    let dmask;
    let here;
    let op;
    let len;
    let dist;
    let from;
    let from_source;
    let input, output;
    const state = strm.state;
    _in = strm.next_in;
    input = strm.input;
    last = _in + (strm.avail_in - 5);
    _out = strm.next_out;
    output = strm.output;
    beg = _out - (start - strm.avail_out);
    end = _out + (strm.avail_out - 257);
    dmax = state.dmax;
    wsize = state.wsize;
    whave = state.whave;
    wnext = state.wnext;
    s_window = state.window;
    hold = state.hold;
    bits = state.bits;
    lcode = state.lencode;
    dcode = state.distcode;
    lmask = (1 << state.lenbits) - 1;
    dmask = (1 << state.distbits) - 1;
    top: do {
      if (bits < 15) {
        hold += input[_in++] << bits;
        bits += 8;
        hold += input[_in++] << bits;
        bits += 8;
      }
      here = lcode[hold & lmask];
      dolen: for (; ; ) {
        op = here >>> 24;
        hold >>>= op;
        bits -= op;
        op = here >>> 16 & 255;
        if (op === 0) output[_out++] = here & 65535;
        else if (op & 16) {
          len = here & 65535;
          op &= 15;
          if (op) {
            if (bits < op) {
              hold += input[_in++] << bits;
              bits += 8;
            }
            len += hold & (1 << op) - 1;
            hold >>>= op;
            bits -= op;
          }
          if (bits < 15) {
            hold += input[_in++] << bits;
            bits += 8;
            hold += input[_in++] << bits;
            bits += 8;
          }
          here = dcode[hold & dmask];
          dodist: for (; ; ) {
            op = here >>> 24;
            hold >>>= op;
            bits -= op;
            op = here >>> 16 & 255;
            if (op & 16) {
              dist = here & 65535;
              op &= 15;
              if (bits < op) {
                hold += input[_in++] << bits;
                bits += 8;
                if (bits < op) {
                  hold += input[_in++] << bits;
                  bits += 8;
                }
              }
              dist += hold & (1 << op) - 1;
              if (dist > dmax) {
                strm.msg = "invalid distance too far back";
                state.mode = BAD$1;
                break top;
              }
              hold >>>= op;
              bits -= op;
              op = _out - beg;
              if (dist > op) {
                op = dist - op;
                if (op > whave) {
                  if (state.sane) {
                    strm.msg = "invalid distance too far back";
                    state.mode = BAD$1;
                    break top;
                  }
                }
                from = 0;
                from_source = s_window;
                if (wnext === 0) {
                  from += wsize - op;
                  if (op < len) {
                    len -= op;
                    do
                      output[_out++] = s_window[from++];
                    while (--op);
                    from = _out - dist;
                    from_source = output;
                  }
                } else if (wnext < op) {
                  from += wsize + wnext - op;
                  op -= wnext;
                  if (op < len) {
                    len -= op;
                    do
                      output[_out++] = s_window[from++];
                    while (--op);
                    from = 0;
                    if (wnext < len) {
                      op = wnext;
                      len -= op;
                      do
                        output[_out++] = s_window[from++];
                      while (--op);
                      from = _out - dist;
                      from_source = output;
                    }
                  }
                } else {
                  from += wnext - op;
                  if (op < len) {
                    len -= op;
                    do
                      output[_out++] = s_window[from++];
                    while (--op);
                    from = _out - dist;
                    from_source = output;
                  }
                }
                while (len > 2) {
                  output[_out++] = from_source[from++];
                  output[_out++] = from_source[from++];
                  output[_out++] = from_source[from++];
                  len -= 3;
                }
                if (len) {
                  output[_out++] = from_source[from++];
                  if (len > 1) output[_out++] = from_source[from++];
                }
              } else {
                from = _out - dist;
                do {
                  output[_out++] = output[from++];
                  output[_out++] = output[from++];
                  output[_out++] = output[from++];
                  len -= 3;
                } while (len > 2);
                if (len) {
                  output[_out++] = output[from++];
                  if (len > 1) output[_out++] = output[from++];
                }
              }
            } else if ((op & 64) === 0) {
              here = dcode[(here & 65535) + (hold & (1 << op) - 1)];
              continue dodist;
            } else {
              strm.msg = "invalid distance code";
              state.mode = BAD$1;
              break top;
            }
            break;
          }
        } else if ((op & 64) === 0) {
          here = lcode[(here & 65535) + (hold & (1 << op) - 1)];
          continue dolen;
        } else if (op & 32) {
          state.mode = TYPE$1;
          break top;
        } else {
          strm.msg = "invalid literal/length code";
          state.mode = BAD$1;
          break top;
        }
        break;
      }
    } while (_in < last && _out < end);
    len = bits >> 3;
    _in -= len;
    bits -= len << 3;
    hold &= (1 << bits) - 1;
    strm.next_in = _in;
    strm.next_out = _out;
    strm.avail_in = _in < last ? 5 + (last - _in) : 5 - (_in - last);
    strm.avail_out = _out < end ? 257 + (end - _out) : 257 - (_out - end);
    state.hold = hold;
    state.bits = bits;
  }
  function deflate(input, options = {}) {
    const deflator = new Deflate(options);
    deflator.push(input, true);
    if (deflator.err) throw new Error(deflator.msg);
    return deflator.result;
  }
  function inflate(input, options = {}) {
    const inflator = new Inflate(options);
    inflator.push(input, true);
    if (inflator.err) throw new Error(inflator.msg);
    const result = inflator.result;
    return options.toText ? new TextDecoder().decode(result) : result;
  }
  var Z_FIXED, Z_BINARY, Z_TEXT, Z_UNKNOWN, STORED_BLOCK, STATIC_TREES, DYN_TREES, LENGTH_CODES, LITERALS, L_CODES, D_CODES, BL_CODES, HEAP_SIZE$1, MAX_BITS, Buf_size, MAX_BL_BITS, END_BLOCK, REP_3_6, REPZ_3_10, REPZ_11_138, extra_lbits, extra_dbits, extra_blbits, bl_order, DIST_CODE_LEN, static_ltree, static_dtree, _dist_code, _length_code, base_length, base_dist, StaticTreeDesc, static_l_desc, static_d_desc, static_bl_desc, TreeDesc, d_code, put_short, send_bits, send_code, bi_reverse, bi_flush, gen_bitlen, gen_codes, tr_static_init, init_block, bi_windup, smaller, pqdownheap, compress_block, build_tree, scan_tree, send_tree, build_bl_tree, send_all_trees, detect_data_type, static_init_done, _tr_init, _tr_stored_block, _tr_align, _tr_flush_block, _tr_tally, adler32, makeTable, crcTable, crc32, messages_default, MAX_MEM_LEVEL, HEAP_SIZE, MIN_MATCH, MAX_MATCH, MIN_LOOKAHEAD, PRESET_DICT, INIT_STATE, GZIP_STATE, EXTRA_STATE, NAME_STATE, COMMENT_STATE, HCRC_STATE, BUSY_STATE, FINISH_STATE, BS_NEED_MORE, BS_BLOCK_DONE, BS_FINISH_STARTED, BS_FINISH_DONE, OS_CODE, err, rank, zero, slide_hash, HASH, INSERT_STRING, flush_pending, flush_block_only, put_byte, putShortMSB, read_buf, longest_match, fill_window, deflate_stored, deflate_fast, deflate_slow, deflate_rle, deflate_huff, Config, configuration_table, lm_init, DeflateState, deflateStateCheck, deflateResetKeep, deflateReset, deflateInit2, deflate$1, deflateEnd, deflateSetDictionary, BAD$1, TYPE$1, MAXBITS, ENOUGH_LENS$1, ENOUGH_DISTS$1, CODES$1, LENS$1, DISTS$1, lbase, lext, dbase, dext, inflate_table, CODES, LENS, DISTS, HEAD, FLAGS, TIME, OS, EXLEN, EXTRA, NAME, COMMENT, HCRC, DICTID, DICT, TYPE, TYPEDO, STORED, COPY_, COPY, TABLE, LENLENS, CODELENS, LEN_, LEN, LENEXT, DIST, DISTEXT, MATCH, LIT, CHECK, LENGTH, DONE, BAD, MEM, SYNC, ENOUGH_LENS, ENOUGH_DISTS, zswap32, InflateState, inflateStateCheck, inflateResetKeep, inflateReset, inflateReset2, inflateInit2, virgin, lenfix, distfix, fixedtables, updatewindow, inflate$1, inflateEnd, inflateSetDictionary, ZStream, flattenChunks, toString$1, defaultOptions$1, Deflate, toString, defaultOptions, Inflate;
  var init_pako = __esm({
    "node_modules/pako/dist/pako.mjs"() {
      Z_FIXED = 4;
      Z_BINARY = 0;
      Z_TEXT = 1;
      Z_UNKNOWN = 2;
      STORED_BLOCK = 0;
      STATIC_TREES = 1;
      DYN_TREES = 2;
      LENGTH_CODES = 29;
      LITERALS = 256;
      L_CODES = 286;
      D_CODES = 30;
      BL_CODES = 19;
      HEAP_SIZE$1 = 573;
      MAX_BITS = 15;
      Buf_size = 16;
      MAX_BL_BITS = 7;
      END_BLOCK = 256;
      REP_3_6 = 16;
      REPZ_3_10 = 17;
      REPZ_11_138 = 18;
      extra_lbits = new Uint8Array([
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
        1,
        1,
        1,
        2,
        2,
        2,
        2,
        3,
        3,
        3,
        3,
        4,
        4,
        4,
        4,
        5,
        5,
        5,
        5,
        0
      ]);
      extra_dbits = new Uint8Array([
        0,
        0,
        0,
        0,
        1,
        1,
        2,
        2,
        3,
        3,
        4,
        4,
        5,
        5,
        6,
        6,
        7,
        7,
        8,
        8,
        9,
        9,
        10,
        10,
        11,
        11,
        12,
        12,
        13,
        13
      ]);
      extra_blbits = new Uint8Array([
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        2,
        3,
        7
      ]);
      bl_order = new Uint8Array([
        16,
        17,
        18,
        0,
        8,
        7,
        9,
        6,
        10,
        5,
        11,
        4,
        12,
        3,
        13,
        2,
        14,
        1,
        15
      ]);
      DIST_CODE_LEN = 512;
      static_ltree = new Array(288 * 2);
      zero$1(static_ltree);
      static_dtree = new Array(D_CODES * 2);
      zero$1(static_dtree);
      _dist_code = new Array(DIST_CODE_LEN);
      zero$1(_dist_code);
      _length_code = new Array(256);
      zero$1(_length_code);
      base_length = new Array(LENGTH_CODES);
      zero$1(base_length);
      base_dist = new Array(D_CODES);
      zero$1(base_dist);
      StaticTreeDesc = class {
        constructor(static_tree, extra_bits, extra_base, elems, max_length) {
          this.static_tree = static_tree;
          this.extra_bits = extra_bits;
          this.extra_base = extra_base;
          this.elems = elems;
          this.max_length = max_length;
          this.has_stree = static_tree && static_tree.length;
        }
      };
      TreeDesc = class {
        constructor(dyn_tree, stat_desc) {
          this.dyn_tree = dyn_tree;
          this.max_code = 0;
          this.stat_desc = stat_desc;
        }
      };
      d_code = (dist) => {
        return dist < 256 ? _dist_code[dist] : _dist_code[256 + (dist >>> 7)];
      };
      put_short = (s, w) => {
        s.pending_buf[s.pending++] = w & 255;
        s.pending_buf[s.pending++] = w >>> 8 & 255;
      };
      send_bits = (s, value, length) => {
        if (s.bi_valid > Buf_size - length) {
          s.bi_buf |= value << s.bi_valid & 65535;
          put_short(s, s.bi_buf);
          s.bi_buf = value >> Buf_size - s.bi_valid;
          s.bi_valid += length - Buf_size;
        } else {
          s.bi_buf |= value << s.bi_valid & 65535;
          s.bi_valid += length;
        }
      };
      send_code = (s, c, tree) => {
        send_bits(s, tree[c * 2], tree[c * 2 + 1]);
      };
      bi_reverse = (code, len) => {
        let res = 0;
        do {
          res |= code & 1;
          code >>>= 1;
          res <<= 1;
        } while (--len > 0);
        return res >>> 1;
      };
      bi_flush = (s) => {
        if (s.bi_valid === 16) {
          put_short(s, s.bi_buf);
          s.bi_buf = 0;
          s.bi_valid = 0;
        } else if (s.bi_valid >= 8) {
          s.pending_buf[s.pending++] = s.bi_buf & 255;
          s.bi_buf >>= 8;
          s.bi_valid -= 8;
        }
      };
      gen_bitlen = (s, desc) => {
        const tree = desc.dyn_tree;
        const max_code = desc.max_code;
        const stree = desc.stat_desc.static_tree;
        const has_stree = desc.stat_desc.has_stree;
        const extra = desc.stat_desc.extra_bits;
        const base = desc.stat_desc.extra_base;
        const max_length = desc.stat_desc.max_length;
        let h;
        let n, m;
        let bits;
        let xbits;
        let f;
        let overflow = 0;
        for (bits = 0; bits <= MAX_BITS; bits++) s.bl_count[bits] = 0;
        tree[s.heap[s.heap_max] * 2 + 1] = 0;
        for (h = s.heap_max + 1; h < HEAP_SIZE$1; h++) {
          n = s.heap[h];
          bits = tree[tree[n * 2 + 1] * 2 + 1] + 1;
          if (bits > max_length) {
            bits = max_length;
            overflow++;
          }
          tree[n * 2 + 1] = bits;
          if (n > max_code) continue;
          s.bl_count[bits]++;
          xbits = 0;
          if (n >= base) xbits = extra[n - base];
          f = tree[n * 2];
          s.opt_len += f * (bits + xbits);
          if (has_stree) s.static_len += f * (stree[n * 2 + 1] + xbits);
        }
        if (overflow === 0) return;
        do {
          bits = max_length - 1;
          while (s.bl_count[bits] === 0) bits--;
          s.bl_count[bits]--;
          s.bl_count[bits + 1] += 2;
          s.bl_count[max_length]--;
          overflow -= 2;
        } while (overflow > 0);
        for (bits = max_length; bits !== 0; bits--) {
          n = s.bl_count[bits];
          while (n !== 0) {
            m = s.heap[--h];
            if (m > max_code) continue;
            if (tree[m * 2 + 1] !== bits) {
              s.opt_len += (bits - tree[m * 2 + 1]) * tree[m * 2];
              tree[m * 2 + 1] = bits;
            }
            n--;
          }
        }
      };
      gen_codes = (tree, max_code, bl_count) => {
        const next_code = new Array(16);
        let code = 0;
        let bits;
        let n;
        for (bits = 1; bits <= MAX_BITS; bits++) {
          code = code + bl_count[bits - 1] << 1;
          next_code[bits] = code;
        }
        for (n = 0; n <= max_code; n++) {
          let len = tree[n * 2 + 1];
          if (len === 0) continue;
          tree[n * 2] = bi_reverse(next_code[len]++, len);
        }
      };
      tr_static_init = () => {
        let n;
        let bits;
        let length;
        let code;
        let dist;
        const bl_count = new Array(16);
        length = 0;
        for (code = 0; code < LENGTH_CODES - 1; code++) {
          base_length[code] = length;
          for (n = 0; n < 1 << extra_lbits[code]; n++) _length_code[length++] = code;
        }
        _length_code[length - 1] = code;
        dist = 0;
        for (code = 0; code < 16; code++) {
          base_dist[code] = dist;
          for (n = 0; n < 1 << extra_dbits[code]; n++) _dist_code[dist++] = code;
        }
        dist >>= 7;
        for (; code < D_CODES; code++) {
          base_dist[code] = dist << 7;
          for (n = 0; n < 1 << extra_dbits[code] - 7; n++) _dist_code[256 + dist++] = code;
        }
        for (bits = 0; bits <= MAX_BITS; bits++) bl_count[bits] = 0;
        n = 0;
        while (n <= 143) {
          static_ltree[n * 2 + 1] = 8;
          n++;
          bl_count[8]++;
        }
        while (n <= 255) {
          static_ltree[n * 2 + 1] = 9;
          n++;
          bl_count[9]++;
        }
        while (n <= 279) {
          static_ltree[n * 2 + 1] = 7;
          n++;
          bl_count[7]++;
        }
        while (n <= 287) {
          static_ltree[n * 2 + 1] = 8;
          n++;
          bl_count[8]++;
        }
        gen_codes(static_ltree, 287, bl_count);
        for (n = 0; n < D_CODES; n++) {
          static_dtree[n * 2 + 1] = 5;
          static_dtree[n * 2] = bi_reverse(n, 5);
        }
        static_l_desc = new StaticTreeDesc(static_ltree, extra_lbits, 257, L_CODES, MAX_BITS);
        static_d_desc = new StaticTreeDesc(static_dtree, extra_dbits, 0, D_CODES, MAX_BITS);
        static_bl_desc = new StaticTreeDesc(new Array(0), extra_blbits, 0, BL_CODES, MAX_BL_BITS);
      };
      init_block = (s) => {
        let n;
        for (n = 0; n < L_CODES; n++) s.dyn_ltree[n * 2] = 0;
        for (n = 0; n < D_CODES; n++) s.dyn_dtree[n * 2] = 0;
        for (n = 0; n < BL_CODES; n++) s.bl_tree[n * 2] = 0;
        s.dyn_ltree[END_BLOCK * 2] = 1;
        s.opt_len = s.static_len = 0;
        s.sym_next = s.matches = 0;
      };
      bi_windup = (s) => {
        if (s.bi_valid > 8) put_short(s, s.bi_buf);
        else if (s.bi_valid > 0) s.pending_buf[s.pending++] = s.bi_buf;
        s.bi_buf = 0;
        s.bi_valid = 0;
      };
      smaller = (tree, n, m, depth) => {
        const _n2 = n * 2;
        const _m2 = m * 2;
        return tree[_n2] < tree[_m2] || tree[_n2] === tree[_m2] && depth[n] <= depth[m];
      };
      pqdownheap = (s, tree, k) => {
        const v = s.heap[k];
        let j = k << 1;
        while (j <= s.heap_len) {
          if (j < s.heap_len && smaller(tree, s.heap[j + 1], s.heap[j], s.depth)) j++;
          if (smaller(tree, v, s.heap[j], s.depth)) break;
          s.heap[k] = s.heap[j];
          k = j;
          j <<= 1;
        }
        s.heap[k] = v;
      };
      compress_block = (s, ltree, dtree) => {
        let dist;
        let lc;
        let sx = 0;
        let code;
        let extra;
        if (s.sym_next !== 0) do {
          dist = s.pending_buf[s.sym_buf + sx++] & 255;
          dist += (s.pending_buf[s.sym_buf + sx++] & 255) << 8;
          lc = s.pending_buf[s.sym_buf + sx++];
          if (dist === 0) send_code(s, lc, ltree);
          else {
            code = _length_code[lc];
            send_code(s, code + LITERALS + 1, ltree);
            extra = extra_lbits[code];
            if (extra !== 0) {
              lc -= base_length[code];
              send_bits(s, lc, extra);
            }
            dist--;
            code = d_code(dist);
            send_code(s, code, dtree);
            extra = extra_dbits[code];
            if (extra !== 0) {
              dist -= base_dist[code];
              send_bits(s, dist, extra);
            }
          }
        } while (sx < s.sym_next);
        send_code(s, END_BLOCK, ltree);
      };
      build_tree = (s, desc) => {
        const tree = desc.dyn_tree;
        const stree = desc.stat_desc.static_tree;
        const has_stree = desc.stat_desc.has_stree;
        const elems = desc.stat_desc.elems;
        let n, m;
        let max_code = -1;
        let node;
        s.heap_len = 0;
        s.heap_max = HEAP_SIZE$1;
        for (n = 0; n < elems; n++) if (tree[n * 2] !== 0) {
          s.heap[++s.heap_len] = max_code = n;
          s.depth[n] = 0;
        } else tree[n * 2 + 1] = 0;
        while (s.heap_len < 2) {
          node = s.heap[++s.heap_len] = max_code < 2 ? ++max_code : 0;
          tree[node * 2] = 1;
          s.depth[node] = 0;
          s.opt_len--;
          if (has_stree) s.static_len -= stree[node * 2 + 1];
        }
        desc.max_code = max_code;
        for (n = s.heap_len >> 1; n >= 1; n--) pqdownheap(s, tree, n);
        node = elems;
        do {
          n = s.heap[1];
          s.heap[1] = s.heap[s.heap_len--];
          pqdownheap(s, tree, 1);
          m = s.heap[1];
          s.heap[--s.heap_max] = n;
          s.heap[--s.heap_max] = m;
          tree[node * 2] = tree[n * 2] + tree[m * 2];
          s.depth[node] = (s.depth[n] >= s.depth[m] ? s.depth[n] : s.depth[m]) + 1;
          tree[n * 2 + 1] = tree[m * 2 + 1] = node;
          s.heap[1] = node++;
          pqdownheap(s, tree, 1);
        } while (s.heap_len >= 2);
        s.heap[--s.heap_max] = s.heap[1];
        gen_bitlen(s, desc);
        gen_codes(tree, max_code, s.bl_count);
      };
      scan_tree = (s, tree, max_code) => {
        let n;
        let prevlen = -1;
        let curlen;
        let nextlen = tree[1];
        let count = 0;
        let max_count = 7;
        let min_count = 4;
        if (nextlen === 0) {
          max_count = 138;
          min_count = 3;
        }
        tree[(max_code + 1) * 2 + 1] = 65535;
        for (n = 0; n <= max_code; n++) {
          curlen = nextlen;
          nextlen = tree[(n + 1) * 2 + 1];
          if (++count < max_count && curlen === nextlen) continue;
          else if (count < min_count) s.bl_tree[curlen * 2] += count;
          else if (curlen !== 0) {
            if (curlen !== prevlen) s.bl_tree[curlen * 2]++;
            s.bl_tree[REP_3_6 * 2]++;
          } else if (count <= 10) s.bl_tree[REPZ_3_10 * 2]++;
          else s.bl_tree[REPZ_11_138 * 2]++;
          count = 0;
          prevlen = curlen;
          if (nextlen === 0) {
            max_count = 138;
            min_count = 3;
          } else if (curlen === nextlen) {
            max_count = 6;
            min_count = 3;
          } else {
            max_count = 7;
            min_count = 4;
          }
        }
      };
      send_tree = (s, tree, max_code) => {
        let n;
        let prevlen = -1;
        let curlen;
        let nextlen = tree[1];
        let count = 0;
        let max_count = 7;
        let min_count = 4;
        if (nextlen === 0) {
          max_count = 138;
          min_count = 3;
        }
        for (n = 0; n <= max_code; n++) {
          curlen = nextlen;
          nextlen = tree[(n + 1) * 2 + 1];
          if (++count < max_count && curlen === nextlen) continue;
          else if (count < min_count) do
            send_code(s, curlen, s.bl_tree);
          while (--count !== 0);
          else if (curlen !== 0) {
            if (curlen !== prevlen) {
              send_code(s, curlen, s.bl_tree);
              count--;
            }
            send_code(s, REP_3_6, s.bl_tree);
            send_bits(s, count - 3, 2);
          } else if (count <= 10) {
            send_code(s, REPZ_3_10, s.bl_tree);
            send_bits(s, count - 3, 3);
          } else {
            send_code(s, REPZ_11_138, s.bl_tree);
            send_bits(s, count - 11, 7);
          }
          count = 0;
          prevlen = curlen;
          if (nextlen === 0) {
            max_count = 138;
            min_count = 3;
          } else if (curlen === nextlen) {
            max_count = 6;
            min_count = 3;
          } else {
            max_count = 7;
            min_count = 4;
          }
        }
      };
      build_bl_tree = (s) => {
        let max_blindex;
        scan_tree(s, s.dyn_ltree, s.l_desc.max_code);
        scan_tree(s, s.dyn_dtree, s.d_desc.max_code);
        build_tree(s, s.bl_desc);
        for (max_blindex = BL_CODES - 1; max_blindex >= 3; max_blindex--) if (s.bl_tree[bl_order[max_blindex] * 2 + 1] !== 0) break;
        s.opt_len += 3 * (max_blindex + 1) + 5 + 5 + 4;
        return max_blindex;
      };
      send_all_trees = (s, lcodes, dcodes, blcodes) => {
        let rank2;
        send_bits(s, lcodes - 257, 5);
        send_bits(s, dcodes - 1, 5);
        send_bits(s, blcodes - 4, 4);
        for (rank2 = 0; rank2 < blcodes; rank2++) send_bits(s, s.bl_tree[bl_order[rank2] * 2 + 1], 3);
        send_tree(s, s.dyn_ltree, lcodes - 1);
        send_tree(s, s.dyn_dtree, dcodes - 1);
      };
      detect_data_type = (s) => {
        let block_mask = 4093624447;
        let n;
        for (n = 0; n <= 31; n++, block_mask >>>= 1) if (block_mask & 1 && s.dyn_ltree[n * 2] !== 0) return Z_BINARY;
        if (s.dyn_ltree[18] !== 0 || s.dyn_ltree[20] !== 0 || s.dyn_ltree[26] !== 0) return Z_TEXT;
        for (n = 32; n < LITERALS; n++) if (s.dyn_ltree[n * 2] !== 0) return Z_TEXT;
        return Z_BINARY;
      };
      static_init_done = false;
      _tr_init = (s) => {
        if (!static_init_done) {
          tr_static_init();
          static_init_done = true;
        }
        s.l_desc = new TreeDesc(s.dyn_ltree, static_l_desc);
        s.d_desc = new TreeDesc(s.dyn_dtree, static_d_desc);
        s.bl_desc = new TreeDesc(s.bl_tree, static_bl_desc);
        s.bi_buf = 0;
        s.bi_valid = 0;
        init_block(s);
      };
      _tr_stored_block = (s, buf, stored_len, last) => {
        send_bits(s, (STORED_BLOCK << 1) + (last ? 1 : 0), 3);
        bi_windup(s);
        put_short(s, stored_len);
        put_short(s, ~stored_len);
        if (stored_len) s.pending_buf.set(s.window.subarray(buf, buf + stored_len), s.pending);
        s.pending += stored_len;
      };
      _tr_align = (s) => {
        send_bits(s, STATIC_TREES << 1, 3);
        send_code(s, END_BLOCK, static_ltree);
        bi_flush(s);
      };
      _tr_flush_block = (s, buf, stored_len, last) => {
        let opt_lenb, static_lenb;
        let max_blindex = 0;
        if (s.level > 0) {
          if (s.strm.data_type === Z_UNKNOWN) s.strm.data_type = detect_data_type(s);
          build_tree(s, s.l_desc);
          build_tree(s, s.d_desc);
          max_blindex = build_bl_tree(s);
          opt_lenb = s.opt_len + 3 + 7 >>> 3;
          static_lenb = s.static_len + 3 + 7 >>> 3;
          if (static_lenb <= opt_lenb) opt_lenb = static_lenb;
        } else opt_lenb = static_lenb = stored_len + 5;
        if (stored_len + 4 <= opt_lenb && buf !== -1) _tr_stored_block(s, buf, stored_len, last);
        else if (s.strategy === Z_FIXED || static_lenb === opt_lenb) {
          send_bits(s, (STATIC_TREES << 1) + (last ? 1 : 0), 3);
          compress_block(s, static_ltree, static_dtree);
        } else {
          send_bits(s, (DYN_TREES << 1) + (last ? 1 : 0), 3);
          send_all_trees(s, s.l_desc.max_code + 1, s.d_desc.max_code + 1, max_blindex + 1);
          compress_block(s, s.dyn_ltree, s.dyn_dtree);
        }
        init_block(s);
        if (last) bi_windup(s);
      };
      _tr_tally = (s, dist, lc) => {
        s.pending_buf[s.sym_buf + s.sym_next++] = dist;
        s.pending_buf[s.sym_buf + s.sym_next++] = dist >> 8;
        s.pending_buf[s.sym_buf + s.sym_next++] = lc;
        if (dist === 0) s.dyn_ltree[lc * 2]++;
        else {
          s.matches++;
          dist--;
          s.dyn_ltree[(_length_code[lc] + LITERALS + 1) * 2]++;
          s.dyn_dtree[d_code(dist) * 2]++;
        }
        return s.sym_next === s.sym_end;
      };
      adler32 = (adler, buf, len, pos) => {
        let s1 = adler & 65535 | 0, s2 = adler >>> 16 & 65535 | 0, n = 0;
        while (len !== 0) {
          n = len > 2e3 ? 2e3 : len;
          len -= n;
          do {
            s1 = s1 + buf[pos++] | 0;
            s2 = s2 + s1 | 0;
          } while (--n);
          s1 %= 65521;
          s2 %= 65521;
        }
        return s1 | s2 << 16 | 0;
      };
      makeTable = () => {
        let c, table = [];
        for (var n = 0; n < 256; n++) {
          c = n;
          for (var k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
          table[n] = c;
        }
        return table;
      };
      crcTable = new Uint32Array(makeTable());
      crc32 = (crc, buf, len, pos) => {
        const t = crcTable;
        const end = pos + len;
        crc ^= -1;
        for (let i = pos; i < end; i++) crc = crc >>> 8 ^ t[(crc ^ buf[i]) & 255];
        return crc ^ -1;
      };
      messages_default = {
        2: "need dictionary",
        1: "stream end",
        0: "",
        "-1": "file error",
        "-2": "stream error",
        "-3": "data error",
        "-4": "insufficient memory",
        "-5": "buffer error",
        "-6": "incompatible version"
      };
      MAX_MEM_LEVEL = 9;
      HEAP_SIZE = 573;
      MIN_MATCH = 3;
      MAX_MATCH = 258;
      MIN_LOOKAHEAD = 262;
      PRESET_DICT = 32;
      INIT_STATE = 42;
      GZIP_STATE = 57;
      EXTRA_STATE = 69;
      NAME_STATE = 73;
      COMMENT_STATE = 91;
      HCRC_STATE = 103;
      BUSY_STATE = 113;
      FINISH_STATE = 666;
      BS_NEED_MORE = 1;
      BS_BLOCK_DONE = 2;
      BS_FINISH_STARTED = 3;
      BS_FINISH_DONE = 4;
      OS_CODE = 3;
      err = (strm, errorCode) => {
        strm.msg = messages_default[errorCode];
        return errorCode;
      };
      rank = (f) => {
        return f * 2 - (f > 4 ? 9 : 0);
      };
      zero = (buf) => {
        let len = buf.length;
        while (--len >= 0) buf[len] = 0;
      };
      slide_hash = (s) => {
        let n, m;
        let p;
        let wsize = s.w_size;
        n = s.hash_size;
        p = n;
        do {
          m = s.head[--p];
          s.head[p] = m >= wsize ? m - wsize : 0;
        } while (--n);
        n = wsize;
        p = n;
        do {
          m = s.prev[--p];
          s.prev[p] = m >= wsize ? m - wsize : 0;
        } while (--n);
      };
      HASH = (s, prev, data) => (prev << s.hash_shift ^ data) & s.hash_mask;
      INSERT_STRING = (s, str) => {
        let h;
        if (s.legacy_hash) h = s.ins_h = HASH(s, s.ins_h, s.window[str + MIN_MATCH - 1]);
        else {
          const w = s.window;
          const value = w[str] | w[str + 1] << 8 | w[str + 2] << 16 | w[str + 3] << 24;
          h = s.ins_h = Math.imul(value, 66521) + 66521 >>> 16 & s.hash_mask;
        }
        const hash_head = s.prev[str & s.w_mask] = s.head[h];
        s.head[h] = str;
        return hash_head;
      };
      flush_pending = (strm) => {
        const s = strm.state;
        let len = s.pending;
        if (len > strm.avail_out) len = strm.avail_out;
        if (len === 0) return;
        strm.output.set(s.pending_buf.subarray(s.pending_out, s.pending_out + len), strm.next_out);
        strm.next_out += len;
        s.pending_out += len;
        strm.total_out += len;
        strm.avail_out -= len;
        s.pending -= len;
        if (s.pending === 0) s.pending_out = 0;
      };
      flush_block_only = (s, last) => {
        _tr_flush_block(s, s.block_start >= 0 ? s.block_start : -1, s.strstart - s.block_start, last);
        s.block_start = s.strstart;
        flush_pending(s.strm);
      };
      put_byte = (s, b) => {
        s.pending_buf[s.pending++] = b;
      };
      putShortMSB = (s, b) => {
        s.pending_buf[s.pending++] = b >>> 8 & 255;
        s.pending_buf[s.pending++] = b & 255;
      };
      read_buf = (strm, buf, start, size) => {
        let len = strm.avail_in;
        if (len > size) len = size;
        if (len === 0) return 0;
        strm.avail_in -= len;
        buf.set(strm.input.subarray(strm.next_in, strm.next_in + len), start);
        if (strm.state.wrap === 1) strm.adler = adler32(strm.adler, buf, len, start);
        else if (strm.state.wrap === 2) strm.adler = crc32(strm.adler, buf, len, start);
        strm.next_in += len;
        strm.total_in += len;
        return len;
      };
      longest_match = (s, cur_match) => {
        let chain_length = s.max_chain_length;
        let scan = s.strstart;
        let match;
        let len;
        let best_len = s.prev_length;
        let nice_match = s.nice_match;
        const limit = s.strstart > s.w_size - MIN_LOOKAHEAD ? s.strstart - (s.w_size - MIN_LOOKAHEAD) : 0;
        const _win = s.window;
        const wmask = s.w_mask;
        const prev = s.prev;
        const strend = s.strstart + MAX_MATCH;
        let scan_end1 = _win[scan + best_len - 1];
        let scan_end = _win[scan + best_len];
        if (s.prev_length >= s.good_match) chain_length >>= 2;
        if (nice_match > s.lookahead) nice_match = s.lookahead;
        do {
          match = cur_match;
          if (_win[match + best_len] !== scan_end || _win[match + best_len - 1] !== scan_end1 || _win[match] !== _win[scan] || _win[++match] !== _win[scan + 1]) continue;
          scan += 2;
          match++;
          do
            ;
          while (_win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && _win[++scan] === _win[++match] && scan < strend);
          len = MAX_MATCH - (strend - scan);
          scan = strend - MAX_MATCH;
          if (len > best_len) {
            s.match_start = cur_match;
            best_len = len;
            if (len >= nice_match) break;
            scan_end1 = _win[scan + best_len - 1];
            scan_end = _win[scan + best_len];
          }
        } while ((cur_match = prev[cur_match & wmask]) > limit && --chain_length !== 0);
        if (best_len <= s.lookahead) return best_len;
        return s.lookahead;
      };
      fill_window = (s) => {
        const _w_size = s.w_size;
        let n, more, str;
        do {
          more = s.window_size - s.lookahead - s.strstart;
          if (s.strstart >= _w_size + (_w_size - MIN_LOOKAHEAD)) {
            s.window.set(s.window.subarray(_w_size, _w_size + _w_size - more), 0);
            s.match_start -= _w_size;
            s.strstart -= _w_size;
            s.block_start -= _w_size;
            if (s.insert > s.strstart) s.insert = s.strstart;
            slide_hash(s);
            more += _w_size;
          }
          if (s.strm.avail_in === 0) break;
          n = read_buf(s.strm, s.window, s.strstart + s.lookahead, more);
          s.lookahead += n;
          if (!s.legacy_hash) {
            if (s.lookahead + s.insert > MIN_MATCH) {
              str = s.strstart - s.insert;
              while (s.insert) {
                INSERT_STRING(s, str);
                str++;
                s.insert--;
                if (s.lookahead + s.insert <= MIN_MATCH) break;
              }
            }
          } else if (s.lookahead + s.insert >= MIN_MATCH) {
            str = s.strstart - s.insert;
            s.ins_h = s.window[str];
            s.ins_h = HASH(s, s.ins_h, s.window[str + 1]);
            while (s.insert) {
              INSERT_STRING(s, str);
              str++;
              s.insert--;
              if (s.lookahead + s.insert < MIN_MATCH) break;
            }
          }
        } while (s.lookahead < MIN_LOOKAHEAD && s.strm.avail_in !== 0);
      };
      deflate_stored = (s, flush) => {
        let min_block = s.pending_buf_size - 5 > s.w_size ? s.w_size : s.pending_buf_size - 5;
        let len, left, have, last = 0;
        let used = s.strm.avail_in;
        do {
          len = 65535;
          have = s.bi_valid + 42 >> 3;
          if (s.strm.avail_out < have) break;
          have = s.strm.avail_out - have;
          left = s.strstart - s.block_start;
          if (len > left + s.strm.avail_in) len = left + s.strm.avail_in;
          if (len > have) len = have;
          if (len < min_block && (len === 0 && flush !== 4 || flush === 0 || len !== left + s.strm.avail_in)) break;
          last = flush === 4 && len === left + s.strm.avail_in ? 1 : 0;
          _tr_stored_block(s, 0, 0, last);
          s.pending_buf[s.pending - 4] = len;
          s.pending_buf[s.pending - 3] = len >> 8;
          s.pending_buf[s.pending - 2] = ~len;
          s.pending_buf[s.pending - 1] = ~len >> 8;
          flush_pending(s.strm);
          if (left) {
            if (left > len) left = len;
            s.strm.output.set(s.window.subarray(s.block_start, s.block_start + left), s.strm.next_out);
            s.strm.next_out += left;
            s.strm.avail_out -= left;
            s.strm.total_out += left;
            s.block_start += left;
            len -= left;
          }
          if (len) {
            read_buf(s.strm, s.strm.output, s.strm.next_out, len);
            s.strm.next_out += len;
            s.strm.avail_out -= len;
            s.strm.total_out += len;
          }
        } while (last === 0);
        used -= s.strm.avail_in;
        if (used) {
          if (used >= s.w_size) {
            s.matches = 2;
            s.window.set(s.strm.input.subarray(s.strm.next_in - s.w_size, s.strm.next_in), 0);
            s.strstart = s.w_size;
            s.insert = s.strstart;
          } else {
            if (s.window_size - s.strstart <= used) {
              s.strstart -= s.w_size;
              s.window.set(s.window.subarray(s.w_size, s.w_size + s.strstart), 0);
              if (s.matches < 2) s.matches++;
              if (s.insert > s.strstart) s.insert = s.strstart;
            }
            s.window.set(s.strm.input.subarray(s.strm.next_in - used, s.strm.next_in), s.strstart);
            s.strstart += used;
            s.insert += used > s.w_size - s.insert ? s.w_size - s.insert : used;
          }
          s.block_start = s.strstart;
        }
        if (s.high_water < s.strstart) s.high_water = s.strstart;
        if (last) return BS_FINISH_DONE;
        if (flush !== 0 && flush !== 4 && s.strm.avail_in === 0 && s.strstart === s.block_start) return BS_BLOCK_DONE;
        have = s.window_size - s.strstart;
        if (s.strm.avail_in > have && s.block_start >= s.w_size) {
          s.block_start -= s.w_size;
          s.strstart -= s.w_size;
          s.window.set(s.window.subarray(s.w_size, s.w_size + s.strstart), 0);
          if (s.matches < 2) s.matches++;
          have += s.w_size;
          if (s.insert > s.strstart) s.insert = s.strstart;
        }
        if (have > s.strm.avail_in) have = s.strm.avail_in;
        if (have) {
          read_buf(s.strm, s.window, s.strstart, have);
          s.strstart += have;
          s.insert += have > s.w_size - s.insert ? s.w_size - s.insert : have;
        }
        if (s.high_water < s.strstart) s.high_water = s.strstart;
        have = s.bi_valid + 42 >> 3;
        have = s.pending_buf_size - have > 65535 ? 65535 : s.pending_buf_size - have;
        min_block = have > s.w_size ? s.w_size : have;
        left = s.strstart - s.block_start;
        if (left >= min_block || (left || flush === 4) && flush !== 0 && s.strm.avail_in === 0 && left <= have) {
          len = left > have ? have : left;
          last = flush === 4 && s.strm.avail_in === 0 && len === left ? 1 : 0;
          _tr_stored_block(s, s.block_start, len, last);
          s.block_start += len;
          flush_pending(s.strm);
        }
        return last ? BS_FINISH_STARTED : BS_NEED_MORE;
      };
      deflate_fast = (s, flush) => {
        let hash_head;
        let bflush;
        for (; ; ) {
          if (s.lookahead < MIN_LOOKAHEAD) {
            fill_window(s);
            if (s.lookahead < MIN_LOOKAHEAD && flush === 0) return BS_NEED_MORE;
            if (s.lookahead === 0) break;
          }
          hash_head = 0;
          if (s.lookahead >= MIN_MATCH) hash_head = INSERT_STRING(s, s.strstart);
          if (hash_head !== 0 && s.strstart - hash_head <= s.w_size - MIN_LOOKAHEAD) s.match_length = longest_match(s, hash_head);
          if (s.match_length >= MIN_MATCH) {
            bflush = _tr_tally(s, s.strstart - s.match_start, s.match_length - MIN_MATCH);
            s.lookahead -= s.match_length;
            if (s.match_length <= s.max_lazy_match && s.lookahead >= MIN_MATCH) {
              s.match_length--;
              do {
                s.strstart++;
                hash_head = INSERT_STRING(s, s.strstart);
              } while (--s.match_length !== 0);
              s.strstart++;
            } else {
              s.strstart += s.match_length;
              s.match_length = 0;
              if (s.legacy_hash) {
                s.ins_h = s.window[s.strstart];
                s.ins_h = HASH(s, s.ins_h, s.window[s.strstart + 1]);
              }
            }
          } else {
            bflush = _tr_tally(s, 0, s.window[s.strstart]);
            s.lookahead--;
            s.strstart++;
          }
          if (bflush) {
            flush_block_only(s, false);
            if (s.strm.avail_out === 0) return BS_NEED_MORE;
          }
        }
        s.insert = s.strstart < MIN_MATCH - 1 ? s.strstart : MIN_MATCH - 1;
        if (flush === 4) {
          flush_block_only(s, true);
          if (s.strm.avail_out === 0) return BS_FINISH_STARTED;
          return BS_FINISH_DONE;
        }
        if (s.sym_next) {
          flush_block_only(s, false);
          if (s.strm.avail_out === 0) return BS_NEED_MORE;
        }
        return BS_BLOCK_DONE;
      };
      deflate_slow = (s, flush) => {
        let hash_head;
        let bflush;
        let max_insert;
        for (; ; ) {
          if (s.lookahead < MIN_LOOKAHEAD) {
            fill_window(s);
            if (s.lookahead < MIN_LOOKAHEAD && flush === 0) return BS_NEED_MORE;
            if (s.lookahead === 0) break;
          }
          hash_head = 0;
          if (s.lookahead >= MIN_MATCH) hash_head = INSERT_STRING(s, s.strstart);
          s.prev_length = s.match_length;
          s.prev_match = s.match_start;
          s.match_length = MIN_MATCH - 1;
          if (hash_head !== 0 && s.prev_length < s.max_lazy_match && s.strstart - hash_head <= s.w_size - MIN_LOOKAHEAD) {
            s.match_length = longest_match(s, hash_head);
            if (s.match_length <= 5 && (s.strategy === 1 || s.match_length === MIN_MATCH && s.strstart - s.match_start > 4096)) s.match_length = MIN_MATCH - 1;
          }
          if (s.prev_length >= MIN_MATCH && s.match_length <= s.prev_length) {
            max_insert = s.strstart + s.lookahead - MIN_MATCH;
            bflush = _tr_tally(s, s.strstart - 1 - s.prev_match, s.prev_length - MIN_MATCH);
            s.lookahead -= s.prev_length - 1;
            s.prev_length -= 2;
            do
              if (++s.strstart <= max_insert) hash_head = INSERT_STRING(s, s.strstart);
            while (--s.prev_length !== 0);
            s.match_available = 0;
            s.match_length = MIN_MATCH - 1;
            s.strstart++;
            if (bflush) {
              flush_block_only(s, false);
              if (s.strm.avail_out === 0) return BS_NEED_MORE;
            }
          } else if (s.match_available) {
            bflush = _tr_tally(s, 0, s.window[s.strstart - 1]);
            if (bflush)
              flush_block_only(s, false);
            s.strstart++;
            s.lookahead--;
            if (s.strm.avail_out === 0) return BS_NEED_MORE;
          } else {
            s.match_available = 1;
            s.strstart++;
            s.lookahead--;
          }
        }
        if (s.match_available) {
          bflush = _tr_tally(s, 0, s.window[s.strstart - 1]);
          s.match_available = 0;
        }
        s.insert = s.strstart < MIN_MATCH - 1 ? s.strstart : MIN_MATCH - 1;
        if (flush === 4) {
          flush_block_only(s, true);
          if (s.strm.avail_out === 0) return BS_FINISH_STARTED;
          return BS_FINISH_DONE;
        }
        if (s.sym_next) {
          flush_block_only(s, false);
          if (s.strm.avail_out === 0) return BS_NEED_MORE;
        }
        return BS_BLOCK_DONE;
      };
      deflate_rle = (s, flush) => {
        let bflush;
        let prev;
        let scan, strend;
        const _win = s.window;
        for (; ; ) {
          if (s.lookahead <= MAX_MATCH) {
            fill_window(s);
            if (s.lookahead <= MAX_MATCH && flush === 0) return BS_NEED_MORE;
            if (s.lookahead === 0) break;
          }
          s.match_length = 0;
          if (s.lookahead >= MIN_MATCH && s.strstart > 0) {
            scan = s.strstart - 1;
            prev = _win[scan];
            if (prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan]) {
              strend = s.strstart + MAX_MATCH;
              do
                ;
              while (prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && prev === _win[++scan] && scan < strend);
              s.match_length = MAX_MATCH - (strend - scan);
              if (s.match_length > s.lookahead) s.match_length = s.lookahead;
            }
          }
          if (s.match_length >= MIN_MATCH) {
            bflush = _tr_tally(s, 1, s.match_length - MIN_MATCH);
            s.lookahead -= s.match_length;
            s.strstart += s.match_length;
            s.match_length = 0;
          } else {
            bflush = _tr_tally(s, 0, s.window[s.strstart]);
            s.lookahead--;
            s.strstart++;
          }
          if (bflush) {
            flush_block_only(s, false);
            if (s.strm.avail_out === 0) return BS_NEED_MORE;
          }
        }
        s.insert = 0;
        if (flush === 4) {
          flush_block_only(s, true);
          if (s.strm.avail_out === 0) return BS_FINISH_STARTED;
          return BS_FINISH_DONE;
        }
        if (s.sym_next) {
          flush_block_only(s, false);
          if (s.strm.avail_out === 0) return BS_NEED_MORE;
        }
        return BS_BLOCK_DONE;
      };
      deflate_huff = (s, flush) => {
        let bflush;
        for (; ; ) {
          if (s.lookahead === 0) {
            fill_window(s);
            if (s.lookahead === 0) {
              if (flush === 0) return BS_NEED_MORE;
              break;
            }
          }
          s.match_length = 0;
          bflush = _tr_tally(s, 0, s.window[s.strstart]);
          s.lookahead--;
          s.strstart++;
          if (bflush) {
            flush_block_only(s, false);
            if (s.strm.avail_out === 0) return BS_NEED_MORE;
          }
        }
        s.insert = 0;
        if (flush === 4) {
          flush_block_only(s, true);
          if (s.strm.avail_out === 0) return BS_FINISH_STARTED;
          return BS_FINISH_DONE;
        }
        if (s.sym_next) {
          flush_block_only(s, false);
          if (s.strm.avail_out === 0) return BS_NEED_MORE;
        }
        return BS_BLOCK_DONE;
      };
      Config = class {
        constructor(good_length, max_lazy, nice_length, max_chain, func) {
          this.good_length = good_length;
          this.max_lazy = max_lazy;
          this.nice_length = nice_length;
          this.max_chain = max_chain;
          this.func = func;
        }
      };
      configuration_table = [
        new Config(0, 0, 0, 0, deflate_stored),
        new Config(4, 4, 8, 4, deflate_fast),
        new Config(4, 5, 16, 8, deflate_fast),
        new Config(4, 6, 32, 32, deflate_fast),
        new Config(4, 4, 16, 16, deflate_slow),
        new Config(8, 16, 32, 32, deflate_slow),
        new Config(8, 16, 128, 128, deflate_slow),
        new Config(8, 32, 128, 256, deflate_slow),
        new Config(32, 128, 258, 1024, deflate_slow),
        new Config(32, 258, 258, 4096, deflate_slow)
      ];
      lm_init = (s) => {
        s.window_size = 2 * s.w_size;
        zero(s.head);
        s.max_lazy_match = configuration_table[s.level].max_lazy;
        s.good_match = configuration_table[s.level].good_length;
        s.nice_match = configuration_table[s.level].nice_length;
        s.max_chain_length = configuration_table[s.level].max_chain;
        s.strstart = 0;
        s.block_start = 0;
        s.lookahead = 0;
        s.insert = 0;
        s.match_length = s.prev_length = MIN_MATCH - 1;
        s.match_available = 0;
        s.ins_h = 0;
      };
      DeflateState = class {
        constructor() {
          this.strm = null;
          this.status = 0;
          this.pending_buf = null;
          this.pending_buf_size = 0;
          this.pending_out = 0;
          this.pending = 0;
          this.wrap = 0;
          this.gzhead = null;
          this.gzindex = 0;
          this.method = 8;
          this.last_flush = -1;
          this.w_size = 0;
          this.w_bits = 0;
          this.w_mask = 0;
          this.window = null;
          this.window_size = 0;
          this.prev = null;
          this.head = null;
          this.ins_h = 0;
          this.legacy_hash = 0;
          this.hash_size = 0;
          this.hash_bits = 0;
          this.hash_mask = 0;
          this.hash_shift = 0;
          this.block_start = 0;
          this.match_length = 0;
          this.prev_match = 0;
          this.match_available = 0;
          this.strstart = 0;
          this.match_start = 0;
          this.lookahead = 0;
          this.prev_length = 0;
          this.max_chain_length = 0;
          this.max_lazy_match = 0;
          this.level = 0;
          this.strategy = 0;
          this.good_match = 0;
          this.nice_match = 0;
          this.dyn_ltree = new Uint16Array(HEAP_SIZE * 2);
          this.dyn_dtree = /* @__PURE__ */ new Uint16Array(122);
          this.bl_tree = /* @__PURE__ */ new Uint16Array(78);
          zero(this.dyn_ltree);
          zero(this.dyn_dtree);
          zero(this.bl_tree);
          this.l_desc = null;
          this.d_desc = null;
          this.bl_desc = null;
          this.bl_count = /* @__PURE__ */ new Uint16Array(16);
          this.heap = /* @__PURE__ */ new Uint16Array(573);
          zero(this.heap);
          this.heap_len = 0;
          this.heap_max = 0;
          this.depth = /* @__PURE__ */ new Uint16Array(573);
          zero(this.depth);
          this.sym_buf = 0;
          this.lit_bufsize = 0;
          this.sym_next = 0;
          this.sym_end = 0;
          this.opt_len = 0;
          this.static_len = 0;
          this.matches = 0;
          this.insert = 0;
          this.bi_buf = 0;
          this.bi_valid = 0;
        }
      };
      deflateStateCheck = (strm) => {
        if (!strm) return 1;
        const s = strm.state;
        if (!s || s.strm !== strm || s.status !== INIT_STATE && s.status !== GZIP_STATE && s.status !== EXTRA_STATE && s.status !== NAME_STATE && s.status !== COMMENT_STATE && s.status !== HCRC_STATE && s.status !== BUSY_STATE && s.status !== FINISH_STATE) return 1;
        return 0;
      };
      deflateResetKeep = (strm) => {
        if (deflateStateCheck(strm)) return err(strm, -2);
        strm.total_in = strm.total_out = 0;
        strm.data_type = 2;
        const s = strm.state;
        s.pending = 0;
        s.pending_out = 0;
        if (s.wrap < 0) s.wrap = -s.wrap;
        s.status = s.wrap === 2 ? GZIP_STATE : s.wrap ? INIT_STATE : BUSY_STATE;
        strm.adler = s.wrap === 2 ? 0 : 1;
        s.last_flush = -2;
        _tr_init(s);
        return 0;
      };
      deflateReset = (strm) => {
        const ret = deflateResetKeep(strm);
        if (ret === 0) lm_init(strm.state);
        return ret;
      };
      deflateInit2 = (strm, level, method, windowBits, memLevel, strategy, legacyHash) => {
        if (!strm) return -2;
        let wrap = 1;
        if (level === -1) level = 6;
        if (windowBits < 0) {
          wrap = 0;
          windowBits = -windowBits;
        } else if (windowBits > 15) {
          wrap = 2;
          windowBits -= 16;
        }
        if (memLevel < 1 || memLevel > MAX_MEM_LEVEL || method !== 8 || windowBits < 8 || windowBits > 15 || level < 0 || level > 9 || strategy < 0 || strategy > 4 || windowBits === 8 && wrap !== 1) return err(strm, -2);
        if (windowBits === 8) windowBits = 9;
        const s = new DeflateState();
        strm.state = s;
        s.strm = strm;
        s.status = INIT_STATE;
        s.wrap = wrap;
        s.gzhead = null;
        s.w_bits = windowBits;
        s.w_size = 1 << s.w_bits;
        s.w_mask = s.w_size - 1;
        s.legacy_hash = legacyHash ? 1 : 0;
        s.hash_bits = memLevel + 7;
        if (!s.legacy_hash && s.hash_bits < 15) s.hash_bits = 15;
        s.hash_size = 1 << s.hash_bits;
        s.hash_mask = s.hash_size - 1;
        s.hash_shift = ~~((s.hash_bits + MIN_MATCH - 1) / MIN_MATCH);
        s.window = new Uint8Array(s.w_size * 2);
        s.head = new Uint16Array(s.hash_size);
        s.prev = new Uint16Array(s.w_size);
        s.lit_bufsize = 1 << memLevel + 6;
        s.pending_buf_size = s.lit_bufsize * 4;
        s.pending_buf = new Uint8Array(s.pending_buf_size);
        s.sym_buf = s.lit_bufsize;
        s.sym_end = (s.lit_bufsize - 1) * 3;
        s.level = level;
        s.strategy = strategy;
        s.method = method;
        return deflateReset(strm);
      };
      deflate$1 = (strm, flush) => {
        if (deflateStateCheck(strm) || flush > 5 || flush < 0) return strm ? err(strm, -2) : -2;
        const s = strm.state;
        if (!strm.output || strm.avail_in !== 0 && !strm.input || s.status === FINISH_STATE && flush !== 4) return err(strm, strm.avail_out === 0 ? -5 : -2);
        const old_flush = s.last_flush;
        s.last_flush = flush;
        if (s.pending !== 0) {
          flush_pending(strm);
          if (strm.avail_out === 0) {
            s.last_flush = -1;
            return 0;
          }
        } else if (strm.avail_in === 0 && rank(flush) <= rank(old_flush) && flush !== 4) return err(strm, -5);
        if (s.status === FINISH_STATE && strm.avail_in !== 0) return err(strm, -5);
        if (s.status === INIT_STATE && s.wrap === 0) s.status = BUSY_STATE;
        if (s.status === INIT_STATE) {
          let header = 8 + (s.w_bits - 8 << 4) << 8;
          let level_flags = -1;
          if (s.strategy >= 2 || s.level < 2) level_flags = 0;
          else if (s.level < 6) level_flags = 1;
          else if (s.level === 6) level_flags = 2;
          else level_flags = 3;
          header |= level_flags << 6;
          if (s.strstart !== 0) header |= PRESET_DICT;
          header += 31 - header % 31;
          putShortMSB(s, header);
          if (s.strstart !== 0) {
            putShortMSB(s, strm.adler >>> 16);
            putShortMSB(s, strm.adler & 65535);
          }
          strm.adler = 1;
          s.status = BUSY_STATE;
          flush_pending(strm);
          if (s.pending !== 0) {
            s.last_flush = -1;
            return 0;
          }
        }
        if (s.status === GZIP_STATE) {
          strm.adler = 0;
          put_byte(s, 31);
          put_byte(s, 139);
          put_byte(s, 8);
          if (!s.gzhead) {
            put_byte(s, 0);
            put_byte(s, 0);
            put_byte(s, 0);
            put_byte(s, 0);
            put_byte(s, 0);
            put_byte(s, s.level === 9 ? 2 : s.strategy >= 2 || s.level < 2 ? 4 : 0);
            put_byte(s, OS_CODE);
            s.status = BUSY_STATE;
            flush_pending(strm);
            if (s.pending !== 0) {
              s.last_flush = -1;
              return 0;
            }
          } else {
            put_byte(s, (s.gzhead.text ? 1 : 0) + (s.gzhead.hcrc ? 2 : 0) + (!s.gzhead.extra ? 0 : 4) + (!s.gzhead.name ? 0 : 8) + (!s.gzhead.comment ? 0 : 16));
            put_byte(s, s.gzhead.time & 255);
            put_byte(s, s.gzhead.time >> 8 & 255);
            put_byte(s, s.gzhead.time >> 16 & 255);
            put_byte(s, s.gzhead.time >> 24 & 255);
            put_byte(s, s.level === 9 ? 2 : s.strategy >= 2 || s.level < 2 ? 4 : 0);
            put_byte(s, s.gzhead.os & 255);
            if (s.gzhead.extra && s.gzhead.extra.length) {
              put_byte(s, s.gzhead.extra.length & 255);
              put_byte(s, s.gzhead.extra.length >> 8 & 255);
            }
            if (s.gzhead.hcrc) strm.adler = crc32(strm.adler, s.pending_buf, s.pending, 0);
            s.gzindex = 0;
            s.status = EXTRA_STATE;
          }
        }
        if (s.status === EXTRA_STATE) {
          if (s.gzhead.extra) {
            let beg = s.pending;
            let left = (s.gzhead.extra.length & 65535) - s.gzindex;
            while (s.pending + left > s.pending_buf_size) {
              let copy = s.pending_buf_size - s.pending;
              s.pending_buf.set(s.gzhead.extra.subarray(s.gzindex, s.gzindex + copy), s.pending);
              s.pending = s.pending_buf_size;
              if (s.gzhead.hcrc && s.pending > beg) strm.adler = crc32(strm.adler, s.pending_buf, s.pending - beg, beg);
              s.gzindex += copy;
              flush_pending(strm);
              if (s.pending !== 0) {
                s.last_flush = -1;
                return 0;
              }
              beg = 0;
              left -= copy;
            }
            let gzhead_extra = new Uint8Array(s.gzhead.extra);
            s.pending_buf.set(gzhead_extra.subarray(s.gzindex, s.gzindex + left), s.pending);
            s.pending += left;
            if (s.gzhead.hcrc && s.pending > beg) strm.adler = crc32(strm.adler, s.pending_buf, s.pending - beg, beg);
            s.gzindex = 0;
          }
          s.status = NAME_STATE;
        }
        if (s.status === NAME_STATE) {
          if (s.gzhead.name) {
            let beg = s.pending;
            let val;
            do {
              if (s.pending === s.pending_buf_size) {
                if (s.gzhead.hcrc && s.pending > beg) strm.adler = crc32(strm.adler, s.pending_buf, s.pending - beg, beg);
                flush_pending(strm);
                if (s.pending !== 0) {
                  s.last_flush = -1;
                  return 0;
                }
                beg = 0;
              }
              if (s.gzindex < s.gzhead.name.length) val = s.gzhead.name.charCodeAt(s.gzindex++) & 255;
              else val = 0;
              put_byte(s, val);
            } while (val !== 0);
            if (s.gzhead.hcrc && s.pending > beg) strm.adler = crc32(strm.adler, s.pending_buf, s.pending - beg, beg);
            s.gzindex = 0;
          }
          s.status = COMMENT_STATE;
        }
        if (s.status === COMMENT_STATE) {
          if (s.gzhead.comment) {
            let beg = s.pending;
            let val;
            do {
              if (s.pending === s.pending_buf_size) {
                if (s.gzhead.hcrc && s.pending > beg) strm.adler = crc32(strm.adler, s.pending_buf, s.pending - beg, beg);
                flush_pending(strm);
                if (s.pending !== 0) {
                  s.last_flush = -1;
                  return 0;
                }
                beg = 0;
              }
              if (s.gzindex < s.gzhead.comment.length) val = s.gzhead.comment.charCodeAt(s.gzindex++) & 255;
              else val = 0;
              put_byte(s, val);
            } while (val !== 0);
            if (s.gzhead.hcrc && s.pending > beg) strm.adler = crc32(strm.adler, s.pending_buf, s.pending - beg, beg);
          }
          s.status = HCRC_STATE;
        }
        if (s.status === HCRC_STATE) {
          if (s.gzhead.hcrc) {
            if (s.pending + 2 > s.pending_buf_size) {
              flush_pending(strm);
              if (s.pending !== 0) {
                s.last_flush = -1;
                return 0;
              }
            }
            put_byte(s, strm.adler & 255);
            put_byte(s, strm.adler >> 8 & 255);
            strm.adler = 0;
          }
          s.status = BUSY_STATE;
          flush_pending(strm);
          if (s.pending !== 0) {
            s.last_flush = -1;
            return 0;
          }
        }
        if (strm.avail_in !== 0 || s.lookahead !== 0 || flush !== 0 && s.status !== FINISH_STATE) {
          let bstate = s.level === 0 ? deflate_stored(s, flush) : s.strategy === 2 ? deflate_huff(s, flush) : s.strategy === 3 ? deflate_rle(s, flush) : configuration_table[s.level].func(s, flush);
          if (bstate === BS_FINISH_STARTED || bstate === BS_FINISH_DONE) s.status = FINISH_STATE;
          if (bstate === BS_NEED_MORE || bstate === BS_FINISH_STARTED) {
            if (strm.avail_out === 0) s.last_flush = -1;
            return 0;
          }
          if (bstate === BS_BLOCK_DONE) {
            if (flush === 1) _tr_align(s);
            else if (flush !== 5) {
              _tr_stored_block(s, 0, 0, false);
              if (flush === 3) {
                zero(s.head);
                if (s.lookahead === 0) {
                  s.strstart = 0;
                  s.block_start = 0;
                  s.insert = 0;
                }
              }
            }
            flush_pending(strm);
            if (strm.avail_out === 0) {
              s.last_flush = -1;
              return 0;
            }
          }
        }
        if (flush !== 4) return 0;
        if (s.wrap <= 0) return 1;
        if (s.wrap === 2) {
          put_byte(s, strm.adler & 255);
          put_byte(s, strm.adler >> 8 & 255);
          put_byte(s, strm.adler >> 16 & 255);
          put_byte(s, strm.adler >> 24 & 255);
          put_byte(s, strm.total_in & 255);
          put_byte(s, strm.total_in >> 8 & 255);
          put_byte(s, strm.total_in >> 16 & 255);
          put_byte(s, strm.total_in >> 24 & 255);
        } else {
          putShortMSB(s, strm.adler >>> 16);
          putShortMSB(s, strm.adler & 65535);
        }
        flush_pending(strm);
        if (s.wrap > 0) s.wrap = -s.wrap;
        return s.pending !== 0 ? 0 : 1;
      };
      deflateEnd = (strm) => {
        if (deflateStateCheck(strm)) return -2;
        const status = strm.state.status;
        strm.state = null;
        return status === BUSY_STATE ? err(strm, -3) : 0;
      };
      deflateSetDictionary = (strm, dictionary) => {
        let dictLength = dictionary.length;
        if (deflateStateCheck(strm)) return -2;
        const s = strm.state;
        const wrap = s.wrap;
        if (wrap === 2 || wrap === 1 && s.status !== INIT_STATE || s.lookahead) return -2;
        if (wrap === 1) strm.adler = adler32(strm.adler, dictionary, dictLength, 0);
        s.wrap = 0;
        if (dictLength >= s.w_size) {
          if (wrap === 0) {
            zero(s.head);
            s.strstart = 0;
            s.block_start = 0;
            s.insert = 0;
          }
          let tmpDict = new Uint8Array(s.w_size);
          tmpDict.set(dictionary.subarray(dictLength - s.w_size, dictLength), 0);
          dictionary = tmpDict;
          dictLength = s.w_size;
        }
        const avail = strm.avail_in;
        const next = strm.next_in;
        const input = strm.input;
        strm.avail_in = dictLength;
        strm.next_in = 0;
        strm.input = dictionary;
        fill_window(s);
        while (s.lookahead >= MIN_MATCH) {
          let str = s.strstart;
          let n = s.lookahead - (MIN_MATCH - 1);
          do {
            INSERT_STRING(s, str);
            str++;
          } while (--n);
          s.strstart = str;
          s.lookahead = MIN_MATCH - 1;
          fill_window(s);
        }
        s.strstart += s.lookahead;
        s.block_start = s.strstart;
        s.insert = s.lookahead;
        s.lookahead = 0;
        s.match_length = s.prev_length = MIN_MATCH - 1;
        s.match_available = 0;
        strm.next_in = next;
        strm.input = input;
        strm.avail_in = avail;
        s.wrap = wrap;
        return 0;
      };
      BAD$1 = 16209;
      TYPE$1 = 16191;
      MAXBITS = 15;
      ENOUGH_LENS$1 = 852;
      ENOUGH_DISTS$1 = 592;
      CODES$1 = 0;
      LENS$1 = 1;
      DISTS$1 = 2;
      lbase = new Uint16Array([
        3,
        4,
        5,
        6,
        7,
        8,
        9,
        10,
        11,
        13,
        15,
        17,
        19,
        23,
        27,
        31,
        35,
        43,
        51,
        59,
        67,
        83,
        99,
        115,
        131,
        163,
        195,
        227,
        258,
        0,
        0
      ]);
      lext = new Uint8Array([
        16,
        16,
        16,
        16,
        16,
        16,
        16,
        16,
        17,
        17,
        17,
        17,
        18,
        18,
        18,
        18,
        19,
        19,
        19,
        19,
        20,
        20,
        20,
        20,
        21,
        21,
        21,
        21,
        16,
        199,
        75
      ]);
      dbase = new Uint16Array([
        1,
        2,
        3,
        4,
        5,
        7,
        9,
        13,
        17,
        25,
        33,
        49,
        65,
        97,
        129,
        193,
        257,
        385,
        513,
        769,
        1025,
        1537,
        2049,
        3073,
        4097,
        6145,
        8193,
        12289,
        16385,
        24577,
        0,
        0
      ]);
      dext = new Uint8Array([
        16,
        16,
        16,
        16,
        17,
        17,
        18,
        18,
        19,
        19,
        20,
        20,
        21,
        21,
        22,
        22,
        23,
        23,
        24,
        24,
        25,
        25,
        26,
        26,
        27,
        27,
        28,
        28,
        29,
        29,
        64,
        64
      ]);
      inflate_table = (type, lens, lens_index, codes, table, table_index, work, opts) => {
        const bits = opts.bits;
        let len = 0;
        let sym = 0;
        let min = 0, max = 0;
        let root = 0;
        let curr = 0;
        let drop = 0;
        let left = 0;
        let used = 0;
        let huff = 0;
        let incr;
        let fill;
        let low;
        let mask;
        let next;
        let base = null;
        let match;
        const count = /* @__PURE__ */ new Uint16Array(16);
        const offs = /* @__PURE__ */ new Uint16Array(16);
        let extra = null;
        let here_bits, here_op, here_val;
        for (len = 0; len <= MAXBITS; len++) count[len] = 0;
        for (sym = 0; sym < codes; sym++) count[lens[lens_index + sym]]++;
        root = bits;
        for (max = MAXBITS; max >= 1; max--) if (count[max] !== 0) break;
        if (root > max) root = max;
        if (max === 0) {
          table[table_index++] = 20971520;
          table[table_index++] = 20971520;
          opts.bits = 1;
          return 0;
        }
        for (min = 1; min < max; min++) if (count[min] !== 0) break;
        if (root < min) root = min;
        left = 1;
        for (len = 1; len <= MAXBITS; len++) {
          left <<= 1;
          left -= count[len];
          if (left < 0) return -1;
        }
        if (left > 0 && (type === CODES$1 || max !== 1)) return -1;
        offs[1] = 0;
        for (len = 1; len < MAXBITS; len++) offs[len + 1] = offs[len] + count[len];
        for (sym = 0; sym < codes; sym++) if (lens[lens_index + sym] !== 0) work[offs[lens[lens_index + sym]]++] = sym;
        if (type === CODES$1) {
          base = extra = work;
          match = 20;
        } else if (type === LENS$1) {
          base = lbase;
          extra = lext;
          match = 257;
        } else {
          base = dbase;
          extra = dext;
          match = 0;
        }
        huff = 0;
        sym = 0;
        len = min;
        next = table_index;
        curr = root;
        drop = 0;
        low = -1;
        used = 1 << root;
        mask = used - 1;
        if (type === LENS$1 && used > ENOUGH_LENS$1 || type === DISTS$1 && used > ENOUGH_DISTS$1) return 1;
        for (; ; ) {
          here_bits = len - drop;
          if (work[sym] + 1 < match) {
            here_op = 0;
            here_val = work[sym];
          } else if (work[sym] >= match) {
            here_op = extra[work[sym] - match];
            here_val = base[work[sym] - match];
          } else {
            here_op = 96;
            here_val = 0;
          }
          incr = 1 << len - drop;
          fill = 1 << curr;
          min = fill;
          do {
            fill -= incr;
            table[next + (huff >> drop) + fill] = here_bits << 24 | here_op << 16 | here_val | 0;
          } while (fill !== 0);
          incr = 1 << len - 1;
          while (huff & incr) incr >>= 1;
          if (incr !== 0) {
            huff &= incr - 1;
            huff += incr;
          } else huff = 0;
          sym++;
          if (--count[len] === 0) {
            if (len === max) break;
            len = lens[lens_index + work[sym]];
          }
          if (len > root && (huff & mask) !== low) {
            if (drop === 0) drop = root;
            next += min;
            curr = len - drop;
            left = 1 << curr;
            while (curr + drop < max) {
              left -= count[curr + drop];
              if (left <= 0) break;
              curr++;
              left <<= 1;
            }
            used += 1 << curr;
            if (type === LENS$1 && used > ENOUGH_LENS$1 || type === DISTS$1 && used > ENOUGH_DISTS$1) return 1;
            low = huff & mask;
            table[low] = root << 24 | curr << 16 | next - table_index | 0;
          }
        }
        if (huff !== 0) table[next + huff] = len - drop << 24 | 4194304;
        opts.bits = root;
        return 0;
      };
      CODES = 0;
      LENS = 1;
      DISTS = 2;
      HEAD = 16180;
      FLAGS = 16181;
      TIME = 16182;
      OS = 16183;
      EXLEN = 16184;
      EXTRA = 16185;
      NAME = 16186;
      COMMENT = 16187;
      HCRC = 16188;
      DICTID = 16189;
      DICT = 16190;
      TYPE = 16191;
      TYPEDO = 16192;
      STORED = 16193;
      COPY_ = 16194;
      COPY = 16195;
      TABLE = 16196;
      LENLENS = 16197;
      CODELENS = 16198;
      LEN_ = 16199;
      LEN = 16200;
      LENEXT = 16201;
      DIST = 16202;
      DISTEXT = 16203;
      MATCH = 16204;
      LIT = 16205;
      CHECK = 16206;
      LENGTH = 16207;
      DONE = 16208;
      BAD = 16209;
      MEM = 16210;
      SYNC = 16211;
      ENOUGH_LENS = 852;
      ENOUGH_DISTS = 592;
      zswap32 = (q) => {
        return (q >>> 24 & 255) + (q >>> 8 & 65280) + ((q & 65280) << 8) + ((q & 255) << 24);
      };
      InflateState = class {
        constructor() {
          this.strm = null;
          this.mode = 0;
          this.last = false;
          this.wrap = 0;
          this.havedict = false;
          this.flags = 0;
          this.dmax = 0;
          this.check = 0;
          this.total = 0;
          this.head = null;
          this.wbits = 0;
          this.wsize = 0;
          this.whave = 0;
          this.wnext = 0;
          this.window = null;
          this.hold = 0;
          this.bits = 0;
          this.length = 0;
          this.offset = 0;
          this.extra = 0;
          this.lencode = null;
          this.distcode = null;
          this.lenbits = 0;
          this.distbits = 0;
          this.ncode = 0;
          this.nlen = 0;
          this.ndist = 0;
          this.have = 0;
          this.next = null;
          this.lens = /* @__PURE__ */ new Uint16Array(320);
          this.work = /* @__PURE__ */ new Uint16Array(288);
          this.lendyn = null;
          this.distdyn = null;
          this.sane = 0;
          this.back = 0;
          this.was = 0;
        }
      };
      inflateStateCheck = (strm) => {
        if (!strm) return 1;
        const state = strm.state;
        if (!state || state.strm !== strm || state.mode < HEAD || state.mode > SYNC) return 1;
        return 0;
      };
      inflateResetKeep = (strm) => {
        if (inflateStateCheck(strm)) return -2;
        const state = strm.state;
        strm.total_in = strm.total_out = state.total = 0;
        strm.msg = "";
        if (state.wrap) strm.adler = state.wrap & 1;
        state.mode = HEAD;
        state.last = 0;
        state.havedict = 0;
        state.flags = -1;
        state.dmax = 32768;
        state.head = null;
        state.hold = 0;
        state.bits = 0;
        state.lencode = state.lendyn = new Int32Array(ENOUGH_LENS);
        state.distcode = state.distdyn = new Int32Array(ENOUGH_DISTS);
        state.sane = 1;
        state.back = -1;
        return 0;
      };
      inflateReset = (strm) => {
        if (inflateStateCheck(strm)) return -2;
        const state = strm.state;
        state.wsize = 0;
        state.whave = 0;
        state.wnext = 0;
        return inflateResetKeep(strm);
      };
      inflateReset2 = (strm, windowBits) => {
        let wrap;
        if (inflateStateCheck(strm)) return -2;
        const state = strm.state;
        if (windowBits < 0) {
          wrap = 0;
          windowBits = -windowBits;
        } else {
          wrap = (windowBits >> 4) + 5;
          if (windowBits < 48) windowBits &= 15;
        }
        if (windowBits && (windowBits < 8 || windowBits > 15)) return -2;
        if (state.window !== null && state.wbits !== windowBits) state.window = null;
        state.wrap = wrap;
        state.wbits = windowBits;
        return inflateReset(strm);
      };
      inflateInit2 = (strm, windowBits) => {
        if (!strm) return -2;
        const state = new InflateState();
        strm.state = state;
        state.strm = strm;
        state.window = null;
        state.mode = HEAD;
        const ret = inflateReset2(strm, windowBits);
        if (ret !== 0) strm.state = null;
        return ret;
      };
      virgin = true;
      fixedtables = (state) => {
        if (virgin) {
          lenfix = /* @__PURE__ */ new Int32Array(512);
          distfix = /* @__PURE__ */ new Int32Array(32);
          let sym = 0;
          while (sym < 144) state.lens[sym++] = 8;
          while (sym < 256) state.lens[sym++] = 9;
          while (sym < 280) state.lens[sym++] = 7;
          while (sym < 288) state.lens[sym++] = 8;
          inflate_table(LENS, state.lens, 0, 288, lenfix, 0, state.work, { bits: 9 });
          sym = 0;
          while (sym < 32) state.lens[sym++] = 5;
          inflate_table(DISTS, state.lens, 0, 32, distfix, 0, state.work, { bits: 5 });
          virgin = false;
        }
        state.lencode = lenfix;
        state.lenbits = 9;
        state.distcode = distfix;
        state.distbits = 5;
      };
      updatewindow = (strm, src, end, copy) => {
        let dist;
        const state = strm.state;
        if (state.window === null) state.window = new Uint8Array(1 << state.wbits);
        if (state.wsize === 0) {
          state.wsize = 1 << state.wbits;
          state.wnext = 0;
          state.whave = 0;
        }
        if (copy >= state.wsize) {
          state.window.set(src.subarray(end - state.wsize, end), 0);
          state.wnext = 0;
          state.whave = state.wsize;
        } else {
          dist = state.wsize - state.wnext;
          if (dist > copy) dist = copy;
          state.window.set(src.subarray(end - copy, end - copy + dist), state.wnext);
          copy -= dist;
          if (copy) {
            state.window.set(src.subarray(end - copy, end), 0);
            state.wnext = copy;
            state.whave = state.wsize;
          } else {
            state.wnext += dist;
            if (state.wnext === state.wsize) state.wnext = 0;
            if (state.whave < state.wsize) state.whave += dist;
          }
        }
        return 0;
      };
      inflate$1 = (strm, flush) => {
        let state;
        let input, output;
        let next;
        let put;
        let have, left;
        let hold;
        let bits;
        let _in, _out;
        let copy;
        let from;
        let from_source;
        let here = 0;
        let here_bits, here_op, here_val;
        let last_bits, last_op, last_val;
        let len;
        let ret;
        const hbuf = /* @__PURE__ */ new Uint8Array(4);
        let opts;
        let n;
        const order = new Uint8Array([
          16,
          17,
          18,
          0,
          8,
          7,
          9,
          6,
          10,
          5,
          11,
          4,
          12,
          3,
          13,
          2,
          14,
          1,
          15
        ]);
        if (inflateStateCheck(strm) || !strm.output || !strm.input && strm.avail_in !== 0) return -2;
        state = strm.state;
        if (state.mode === TYPE) state.mode = TYPEDO;
        put = strm.next_out;
        output = strm.output;
        left = strm.avail_out;
        next = strm.next_in;
        input = strm.input;
        have = strm.avail_in;
        hold = state.hold;
        bits = state.bits;
        _in = have;
        _out = left;
        ret = 0;
        inf_leave: for (; ; ) switch (state.mode) {
          case HEAD:
            if (state.wrap === 0) {
              state.mode = TYPEDO;
              break;
            }
            while (bits < 16) {
              if (have === 0) break inf_leave;
              have--;
              hold += input[next++] << bits;
              bits += 8;
            }
            if (state.wrap & 2 && hold === 35615) {
              if (state.wbits === 0) state.wbits = 15;
              state.check = 0;
              hbuf[0] = hold & 255;
              hbuf[1] = hold >>> 8 & 255;
              state.check = crc32(state.check, hbuf, 2, 0);
              hold = 0;
              bits = 0;
              state.mode = FLAGS;
              break;
            }
            if (state.head) state.head.done = false;
            if (!(state.wrap & 1) || (((hold & 255) << 8) + (hold >> 8)) % 31) {
              strm.msg = "incorrect header check";
              state.mode = BAD;
              break;
            }
            if ((hold & 15) !== 8) {
              strm.msg = "unknown compression method";
              state.mode = BAD;
              break;
            }
            hold >>>= 4;
            bits -= 4;
            len = (hold & 15) + 8;
            if (state.wbits === 0) state.wbits = len;
            if (len > 15 || len > state.wbits) {
              strm.msg = "invalid window size";
              state.mode = BAD;
              break;
            }
            state.dmax = 1 << state.wbits;
            state.flags = 0;
            strm.adler = state.check = 1;
            state.mode = hold & 512 ? DICTID : TYPE;
            hold = 0;
            bits = 0;
            break;
          case FLAGS:
            while (bits < 16) {
              if (have === 0) break inf_leave;
              have--;
              hold += input[next++] << bits;
              bits += 8;
            }
            state.flags = hold;
            if ((state.flags & 255) !== 8) {
              strm.msg = "unknown compression method";
              state.mode = BAD;
              break;
            }
            if (state.flags & 57344) {
              strm.msg = "unknown header flags set";
              state.mode = BAD;
              break;
            }
            if (state.head) state.head.text = hold >> 8 & 1;
            if (state.flags & 512 && state.wrap & 4) {
              hbuf[0] = hold & 255;
              hbuf[1] = hold >>> 8 & 255;
              state.check = crc32(state.check, hbuf, 2, 0);
            }
            hold = 0;
            bits = 0;
            state.mode = TIME;
          case TIME:
            while (bits < 32) {
              if (have === 0) break inf_leave;
              have--;
              hold += input[next++] << bits;
              bits += 8;
            }
            if (state.head) state.head.time = hold;
            if (state.flags & 512 && state.wrap & 4) {
              hbuf[0] = hold & 255;
              hbuf[1] = hold >>> 8 & 255;
              hbuf[2] = hold >>> 16 & 255;
              hbuf[3] = hold >>> 24 & 255;
              state.check = crc32(state.check, hbuf, 4, 0);
            }
            hold = 0;
            bits = 0;
            state.mode = OS;
          case OS:
            while (bits < 16) {
              if (have === 0) break inf_leave;
              have--;
              hold += input[next++] << bits;
              bits += 8;
            }
            if (state.head) {
              state.head.xflags = hold & 255;
              state.head.os = hold >> 8;
            }
            if (state.flags & 512 && state.wrap & 4) {
              hbuf[0] = hold & 255;
              hbuf[1] = hold >>> 8 & 255;
              state.check = crc32(state.check, hbuf, 2, 0);
            }
            hold = 0;
            bits = 0;
            state.mode = EXLEN;
          case EXLEN:
            if (state.flags & 1024) {
              while (bits < 16) {
                if (have === 0) break inf_leave;
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              state.length = hold;
              if (state.head) state.head.extra_len = hold;
              if (state.flags & 512 && state.wrap & 4) {
                hbuf[0] = hold & 255;
                hbuf[1] = hold >>> 8 & 255;
                state.check = crc32(state.check, hbuf, 2, 0);
              }
              hold = 0;
              bits = 0;
            } else if (state.head) state.head.extra = null;
            state.mode = EXTRA;
          case EXTRA:
            if (state.flags & 1024) {
              copy = state.length;
              if (copy > have) copy = have;
              if (copy) {
                if (state.head) {
                  len = state.head.extra_len - state.length;
                  if (!state.head.extra) state.head.extra = new Uint8Array(state.head.extra_len);
                  state.head.extra.set(input.subarray(next, next + copy), len);
                }
                if (state.flags & 512 && state.wrap & 4) state.check = crc32(state.check, input, copy, next);
                have -= copy;
                next += copy;
                state.length -= copy;
              }
              if (state.length) break inf_leave;
            }
            state.length = 0;
            state.mode = NAME;
          case NAME:
            if (state.flags & 2048) {
              if (have === 0) break inf_leave;
              copy = 0;
              do {
                len = input[next + copy++];
                if (state.head && len && state.length < 65536) state.head.name += String.fromCharCode(len);
              } while (len && copy < have);
              if (state.flags & 512 && state.wrap & 4) state.check = crc32(state.check, input, copy, next);
              have -= copy;
              next += copy;
              if (len) break inf_leave;
            } else if (state.head) state.head.name = null;
            state.length = 0;
            state.mode = COMMENT;
          case COMMENT:
            if (state.flags & 4096) {
              if (have === 0) break inf_leave;
              copy = 0;
              do {
                len = input[next + copy++];
                if (state.head && len && state.length < 65536) state.head.comment += String.fromCharCode(len);
              } while (len && copy < have);
              if (state.flags & 512 && state.wrap & 4) state.check = crc32(state.check, input, copy, next);
              have -= copy;
              next += copy;
              if (len) break inf_leave;
            } else if (state.head) state.head.comment = null;
            state.mode = HCRC;
          case HCRC:
            if (state.flags & 512) {
              while (bits < 16) {
                if (have === 0) break inf_leave;
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              if (state.wrap & 4 && hold !== (state.check & 65535)) {
                strm.msg = "header crc mismatch";
                state.mode = BAD;
                break;
              }
              hold = 0;
              bits = 0;
            }
            if (state.head) {
              state.head.hcrc = state.flags >> 9 & 1;
              state.head.done = true;
            }
            strm.adler = state.check = 0;
            state.mode = TYPE;
            break;
          case DICTID:
            while (bits < 32) {
              if (have === 0) break inf_leave;
              have--;
              hold += input[next++] << bits;
              bits += 8;
            }
            strm.adler = state.check = zswap32(hold);
            hold = 0;
            bits = 0;
            state.mode = DICT;
          case DICT:
            if (state.havedict === 0) {
              strm.next_out = put;
              strm.avail_out = left;
              strm.next_in = next;
              strm.avail_in = have;
              state.hold = hold;
              state.bits = bits;
              return 2;
            }
            strm.adler = state.check = 1;
            state.mode = TYPE;
          case TYPE:
            if (flush === 5 || flush === 6) break inf_leave;
          case TYPEDO:
            if (state.last) {
              hold >>>= bits & 7;
              bits -= bits & 7;
              state.mode = CHECK;
              break;
            }
            while (bits < 3) {
              if (have === 0) break inf_leave;
              have--;
              hold += input[next++] << bits;
              bits += 8;
            }
            state.last = hold & 1;
            hold >>>= 1;
            bits -= 1;
            switch (hold & 3) {
              case 0:
                state.mode = STORED;
                break;
              case 1:
                fixedtables(state);
                state.mode = LEN_;
                if (flush === 6) {
                  hold >>>= 2;
                  bits -= 2;
                  break inf_leave;
                }
                break;
              case 2:
                state.mode = TABLE;
                break;
              case 3:
                strm.msg = "invalid block type";
                state.mode = BAD;
            }
            hold >>>= 2;
            bits -= 2;
            break;
          case STORED:
            hold >>>= bits & 7;
            bits -= bits & 7;
            while (bits < 32) {
              if (have === 0) break inf_leave;
              have--;
              hold += input[next++] << bits;
              bits += 8;
            }
            if ((hold & 65535) !== (hold >>> 16 ^ 65535)) {
              strm.msg = "invalid stored block lengths";
              state.mode = BAD;
              break;
            }
            state.length = hold & 65535;
            hold = 0;
            bits = 0;
            state.mode = COPY_;
            if (flush === 6) break inf_leave;
          case COPY_:
            state.mode = COPY;
          case COPY:
            copy = state.length;
            if (copy) {
              if (copy > have) copy = have;
              if (copy > left) copy = left;
              if (copy === 0) break inf_leave;
              output.set(input.subarray(next, next + copy), put);
              have -= copy;
              next += copy;
              left -= copy;
              put += copy;
              state.length -= copy;
              break;
            }
            state.mode = TYPE;
            break;
          case TABLE:
            while (bits < 14) {
              if (have === 0) break inf_leave;
              have--;
              hold += input[next++] << bits;
              bits += 8;
            }
            state.nlen = (hold & 31) + 257;
            hold >>>= 5;
            bits -= 5;
            state.ndist = (hold & 31) + 1;
            hold >>>= 5;
            bits -= 5;
            state.ncode = (hold & 15) + 4;
            hold >>>= 4;
            bits -= 4;
            if (state.nlen > 286 || state.ndist > 30) {
              strm.msg = "too many length or distance symbols";
              state.mode = BAD;
              break;
            }
            state.have = 0;
            state.mode = LENLENS;
          case LENLENS:
            while (state.have < state.ncode) {
              while (bits < 3) {
                if (have === 0) break inf_leave;
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              state.lens[order[state.have++]] = hold & 7;
              hold >>>= 3;
              bits -= 3;
            }
            while (state.have < 19) state.lens[order[state.have++]] = 0;
            state.lencode = state.lendyn;
            state.lenbits = 7;
            opts = { bits: state.lenbits };
            ret = inflate_table(CODES, state.lens, 0, 19, state.lencode, 0, state.work, opts);
            state.lenbits = opts.bits;
            if (ret) {
              strm.msg = "invalid code lengths set";
              state.mode = BAD;
              break;
            }
            state.have = 0;
            state.mode = CODELENS;
          case CODELENS:
            while (state.have < state.nlen + state.ndist) {
              for (; ; ) {
                here = state.lencode[hold & (1 << state.lenbits) - 1];
                here_bits = here >>> 24;
                here_op = here >>> 16 & 255;
                here_val = here & 65535;
                if (here_bits <= bits) break;
                if (have === 0) break inf_leave;
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              if (here_val < 16) {
                hold >>>= here_bits;
                bits -= here_bits;
                state.lens[state.have++] = here_val;
              } else {
                if (here_val === 16) {
                  n = here_bits + 2;
                  while (bits < n) {
                    if (have === 0) break inf_leave;
                    have--;
                    hold += input[next++] << bits;
                    bits += 8;
                  }
                  hold >>>= here_bits;
                  bits -= here_bits;
                  if (state.have === 0) {
                    strm.msg = "invalid bit length repeat";
                    state.mode = BAD;
                    break;
                  }
                  len = state.lens[state.have - 1];
                  copy = 3 + (hold & 3);
                  hold >>>= 2;
                  bits -= 2;
                } else if (here_val === 17) {
                  n = here_bits + 3;
                  while (bits < n) {
                    if (have === 0) break inf_leave;
                    have--;
                    hold += input[next++] << bits;
                    bits += 8;
                  }
                  hold >>>= here_bits;
                  bits -= here_bits;
                  len = 0;
                  copy = 3 + (hold & 7);
                  hold >>>= 3;
                  bits -= 3;
                } else {
                  n = here_bits + 7;
                  while (bits < n) {
                    if (have === 0) break inf_leave;
                    have--;
                    hold += input[next++] << bits;
                    bits += 8;
                  }
                  hold >>>= here_bits;
                  bits -= here_bits;
                  len = 0;
                  copy = 11 + (hold & 127);
                  hold >>>= 7;
                  bits -= 7;
                }
                if (state.have + copy > state.nlen + state.ndist) {
                  strm.msg = "invalid bit length repeat";
                  state.mode = BAD;
                  break;
                }
                while (copy--) state.lens[state.have++] = len;
              }
            }
            if (state.mode === BAD) break;
            if (state.lens[256] === 0) {
              strm.msg = "invalid code -- missing end-of-block";
              state.mode = BAD;
              break;
            }
            state.lenbits = 9;
            opts = { bits: state.lenbits };
            ret = inflate_table(LENS, state.lens, 0, state.nlen, state.lencode, 0, state.work, opts);
            state.lenbits = opts.bits;
            if (ret) {
              strm.msg = "invalid literal/lengths set";
              state.mode = BAD;
              break;
            }
            state.distbits = 6;
            state.distcode = state.distdyn;
            opts = { bits: state.distbits };
            ret = inflate_table(DISTS, state.lens, state.nlen, state.ndist, state.distcode, 0, state.work, opts);
            state.distbits = opts.bits;
            if (ret) {
              strm.msg = "invalid distances set";
              state.mode = BAD;
              break;
            }
            state.mode = LEN_;
            if (flush === 6) break inf_leave;
          case LEN_:
            state.mode = LEN;
          case LEN:
            if (have >= 6 && left >= 258) {
              strm.next_out = put;
              strm.avail_out = left;
              strm.next_in = next;
              strm.avail_in = have;
              state.hold = hold;
              state.bits = bits;
              inflate_fast(strm, _out);
              put = strm.next_out;
              output = strm.output;
              left = strm.avail_out;
              next = strm.next_in;
              input = strm.input;
              have = strm.avail_in;
              hold = state.hold;
              bits = state.bits;
              if (state.mode === TYPE) state.back = -1;
              break;
            }
            state.back = 0;
            for (; ; ) {
              here = state.lencode[hold & (1 << state.lenbits) - 1];
              here_bits = here >>> 24;
              here_op = here >>> 16 & 255;
              here_val = here & 65535;
              if (here_bits <= bits) break;
              if (have === 0) break inf_leave;
              have--;
              hold += input[next++] << bits;
              bits += 8;
            }
            if (here_op && (here_op & 240) === 0) {
              last_bits = here_bits;
              last_op = here_op;
              last_val = here_val;
              for (; ; ) {
                here = state.lencode[last_val + ((hold & (1 << last_bits + last_op) - 1) >> last_bits)];
                here_bits = here >>> 24;
                here_op = here >>> 16 & 255;
                here_val = here & 65535;
                if (last_bits + here_bits <= bits) break;
                if (have === 0) break inf_leave;
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              hold >>>= last_bits;
              bits -= last_bits;
              state.back += last_bits;
            }
            hold >>>= here_bits;
            bits -= here_bits;
            state.back += here_bits;
            state.length = here_val;
            if (here_op === 0) {
              state.mode = LIT;
              break;
            }
            if (here_op & 32) {
              state.back = -1;
              state.mode = TYPE;
              break;
            }
            if (here_op & 64) {
              strm.msg = "invalid literal/length code";
              state.mode = BAD;
              break;
            }
            state.extra = here_op & 15;
            state.mode = LENEXT;
          case LENEXT:
            if (state.extra) {
              n = state.extra;
              while (bits < n) {
                if (have === 0) break inf_leave;
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              state.length += hold & (1 << state.extra) - 1;
              hold >>>= state.extra;
              bits -= state.extra;
              state.back += state.extra;
            }
            state.was = state.length;
            state.mode = DIST;
          case DIST:
            for (; ; ) {
              here = state.distcode[hold & (1 << state.distbits) - 1];
              here_bits = here >>> 24;
              here_op = here >>> 16 & 255;
              here_val = here & 65535;
              if (here_bits <= bits) break;
              if (have === 0) break inf_leave;
              have--;
              hold += input[next++] << bits;
              bits += 8;
            }
            if ((here_op & 240) === 0) {
              last_bits = here_bits;
              last_op = here_op;
              last_val = here_val;
              for (; ; ) {
                here = state.distcode[last_val + ((hold & (1 << last_bits + last_op) - 1) >> last_bits)];
                here_bits = here >>> 24;
                here_op = here >>> 16 & 255;
                here_val = here & 65535;
                if (last_bits + here_bits <= bits) break;
                if (have === 0) break inf_leave;
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              hold >>>= last_bits;
              bits -= last_bits;
              state.back += last_bits;
            }
            hold >>>= here_bits;
            bits -= here_bits;
            state.back += here_bits;
            if (here_op & 64) {
              strm.msg = "invalid distance code";
              state.mode = BAD;
              break;
            }
            state.offset = here_val;
            state.extra = here_op & 15;
            state.mode = DISTEXT;
          case DISTEXT:
            if (state.extra) {
              n = state.extra;
              while (bits < n) {
                if (have === 0) break inf_leave;
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              state.offset += hold & (1 << state.extra) - 1;
              hold >>>= state.extra;
              bits -= state.extra;
              state.back += state.extra;
            }
            if (state.offset > state.dmax) {
              strm.msg = "invalid distance too far back";
              state.mode = BAD;
              break;
            }
            state.mode = MATCH;
          case MATCH:
            if (left === 0) break inf_leave;
            copy = _out - left;
            if (state.offset > copy) {
              copy = state.offset - copy;
              if (copy > state.whave) {
                if (state.sane) {
                  strm.msg = "invalid distance too far back";
                  state.mode = BAD;
                  break;
                }
              }
              if (copy > state.wnext) {
                copy -= state.wnext;
                from = state.wsize - copy;
              } else from = state.wnext - copy;
              if (copy > state.length) copy = state.length;
              from_source = state.window;
            } else {
              from_source = output;
              from = put - state.offset;
              copy = state.length;
            }
            if (copy > left) copy = left;
            left -= copy;
            state.length -= copy;
            do
              output[put++] = from_source[from++];
            while (--copy);
            if (state.length === 0) state.mode = LEN;
            break;
          case LIT:
            if (left === 0) break inf_leave;
            output[put++] = state.length;
            left--;
            state.mode = LEN;
            break;
          case CHECK:
            if (state.wrap) {
              while (bits < 32) {
                if (have === 0) break inf_leave;
                have--;
                hold |= input[next++] << bits;
                bits += 8;
              }
              _out -= left;
              strm.total_out += _out;
              state.total += _out;
              if (state.wrap & 4 && _out) strm.adler = state.check = state.flags ? crc32(state.check, output, _out, put - _out) : adler32(state.check, output, _out, put - _out);
              _out = left;
              if (state.wrap & 4 && (state.flags ? hold : zswap32(hold)) !== state.check) {
                strm.msg = "incorrect data check";
                state.mode = BAD;
                break;
              }
              hold = 0;
              bits = 0;
            }
            state.mode = LENGTH;
          case LENGTH:
            if (state.wrap && state.flags) {
              while (bits < 32) {
                if (have === 0) break inf_leave;
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              if (state.wrap & 4 && hold !== (state.total & 4294967295)) {
                strm.msg = "incorrect length check";
                state.mode = BAD;
                break;
              }
              hold = 0;
              bits = 0;
            }
            state.mode = DONE;
          case DONE:
            ret = 1;
            break inf_leave;
          case BAD:
            ret = -3;
            break inf_leave;
          case MEM:
            return -4;
          case SYNC:
          default:
            return -2;
        }
        strm.next_out = put;
        strm.avail_out = left;
        strm.next_in = next;
        strm.avail_in = have;
        state.hold = hold;
        state.bits = bits;
        if (state.wsize || _out !== strm.avail_out && state.mode < BAD && (state.mode < CHECK || flush !== 4)) {
          if (updatewindow(strm, strm.output, strm.next_out, _out - strm.avail_out)) {
            state.mode = MEM;
            return -4;
          }
        }
        _in -= strm.avail_in;
        _out -= strm.avail_out;
        strm.total_in += _in;
        strm.total_out += _out;
        state.total += _out;
        if (state.wrap & 4 && _out) strm.adler = state.check = state.flags ? crc32(state.check, output, _out, strm.next_out - _out) : adler32(state.check, output, _out, strm.next_out - _out);
        strm.data_type = state.bits + (state.last ? 64 : 0) + (state.mode === TYPE ? 128 : 0) + (state.mode === LEN_ || state.mode === COPY_ ? 256 : 0);
        if ((_in === 0 && _out === 0 || flush === 4) && ret === 0) ret = -5;
        return ret;
      };
      inflateEnd = (strm) => {
        if (inflateStateCheck(strm)) return -2;
        let state = strm.state;
        if (state.window) state.window = null;
        strm.state = null;
        return 0;
      };
      inflateSetDictionary = (strm, dictionary) => {
        const dictLength = dictionary.length;
        let state;
        let dictid;
        let ret;
        if (inflateStateCheck(strm)) return -2;
        state = strm.state;
        if (state.wrap !== 0 && state.mode !== DICT) return -2;
        if (state.mode === DICT) {
          dictid = 1;
          dictid = adler32(dictid, dictionary, dictLength, 0);
          if (dictid !== state.check) return -3;
        }
        ret = updatewindow(strm, dictionary, dictLength, dictLength);
        if (ret) {
          state.mode = MEM;
          return -4;
        }
        state.havedict = 1;
        return 0;
      };
      ZStream = class {
        constructor() {
          this.input = null;
          this.next_in = 0;
          this.avail_in = 0;
          this.total_in = 0;
          this.output = null;
          this.next_out = 0;
          this.avail_out = 0;
          this.total_out = 0;
          this.msg = "";
          this.state = null;
          this.data_type = 2;
          this.adler = 0;
        }
      };
      flattenChunks = (chunks) => {
        const result = new Uint8Array(chunks.reduce((len, chunk) => len + chunk.length, 0));
        let pos = 0;
        for (const chunk of chunks) {
          result.set(chunk, pos);
          pos += chunk.length;
        }
        return result;
      };
      toString$1 = Object.prototype.toString;
      defaultOptions$1 = {
        level: -1,
        chunkSize: 16384,
        windowBits: 15,
        memLevel: 8,
        strategy: 0,
        raw: false,
        gzip: false,
        legacyHash: false,
        dictionary: /* @__PURE__ */ new Uint8Array(0)
      };
      Deflate = class {
        /**
        * Creates a new deflator instance with the specified params. Throws an
        * exception on bad params. See {@link DeflateOptions} for the list of
        * supported options.
        *
        * @example
        * ```javascript
        * import { Deflate } from 'pako'
        *
        * const chunk1 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
        * const chunk2 = new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
        *
        * const deflate = new Deflate({ level: 3 })
        *
        * deflate.push(chunk1, false)
        * deflate.push(chunk2, true)  // true -> last chunk
        *
        * if (deflate.err) throw new Error(deflate.err)
        *
        * console.log(deflate.result)
        * ```
        */
        constructor(options = {}) {
          __publicField(this, "options");
          /**
          * Error code after deflate finishes. {@link Z_OK} on success.
          * You will not need it in real life, because deflate errors
          * are possible only on wrong options or bad custom `onData` / `onEnd`
          * handlers.
          */
          __publicField(this, "err");
          /** Error message, if {@link Deflate.err} is not {@link Z_OK}. */
          __publicField(this, "msg");
          __publicField(this, "ended");
          __publicField(this, "started");
          /**
          * Chunks of output data, if {@link Deflate.onData} not overridden.
          * @internal
          */
          __publicField(this, "chunks");
          __publicField(this, "strm");
          /**
          * Compressed result, generated by default {@link Deflate.onData}
          * and {@link Deflate.onEnd} handlers. Filled after you push last chunk
          * (call {@link Deflate.push} with {@link Z_FINISH} / `true` param).
          */
          __publicField(this, "result");
          this.options = Object.assign({}, defaultOptions$1, options);
          const opt = this.options;
          if (opt.raw && opt.windowBits > 0) opt.windowBits = -opt.windowBits;
          else if (opt.gzip && opt.windowBits > 0 && opt.windowBits < 16) opt.windowBits += 16;
          this.err = 0;
          this.msg = "";
          this.ended = false;
          this.started = false;
          this.chunks = [];
          this.result = /* @__PURE__ */ new Uint8Array(0);
          this.strm = new ZStream();
          this.strm.avail_out = 0;
          let status = deflateInit2(this.strm, opt.level, 8, opt.windowBits, opt.memLevel, opt.strategy, opt.legacyHash);
          if (status !== 0) throw new Error(messages_default[status]);
          if (toString$1.call(opt.dictionary) === "[object ArrayBuffer]") opt.dictionary = new Uint8Array(opt.dictionary);
          const dictionary = opt.dictionary;
          if (dictionary.length) {
            if (opt.gzip) throw new Error("dictionary is not supported with gzip");
            status = deflateSetDictionary(this.strm, dictionary);
            if (status !== 0) throw new Error(messages_default[status]);
          }
        }
        /**
        * Sends input data to the deflate pipe, generating {@link Deflate.onData} calls
        * with new compressed chunks. Returns `true` on success. The last data block must
        * have `flush_mode` {@link Z_FINISH} (or `true`). That will flush the internal
        * pending buffers and call {@link Deflate.onEnd}.
        *
        * On failure, calls {@link Deflate.onEnd} with the error code and returns false.
        *
        * @param data input data. Strings will be converted to utf8 byte sequence.
        * @param flush_mode 0..6 for corresponding {@link Z_NO_FLUSH}..{@link Z_TREES} modes.
        *   See constants. Skipped or `false` means {@link Z_NO_FLUSH}, `true` means {@link Z_FINISH}.
        *
        * @example
        * ```javascript
        * push(chunk, false) // push one of data chunks
        * ...
        * push(chunk, true)  // push last chunk
        * ```
        */
        push(data, flush_mode = false) {
          const strm = this.strm;
          const chunkSize = this.options.chunkSize;
          let status;
          let _flush_mode;
          if (this.ended) return false;
          if (typeof flush_mode === "number") _flush_mode = flush_mode;
          else _flush_mode = flush_mode === true ? 4 : 0;
          if (typeof data === "string") strm.input = new TextEncoder().encode(data);
          else if (toString$1.call(data) === "[object ArrayBuffer]") strm.input = new Uint8Array(data);
          else strm.input = data;
          strm.next_in = 0;
          strm.avail_in = strm.input.length;
          if (!this.started) {
            this.started = true;
            this.onStart(strm);
          }
          for (; ; ) {
            if (strm.avail_out === 0) {
              strm.output = new Uint8Array(chunkSize);
              strm.next_out = 0;
              strm.avail_out = chunkSize;
            }
            if ((_flush_mode === 2 || _flush_mode === 3) && strm.avail_out <= 6) {
              this.onData(strm.output.subarray(0, strm.next_out));
              strm.avail_out = 0;
              continue;
            }
            status = deflate$1(strm, _flush_mode);
            if (status === -2) break;
            if (status === 1) {
              if (strm.next_out > 0) this.onData(strm.output.subarray(0, strm.next_out));
              status = deflateEnd(this.strm);
              break;
            }
            if (strm.avail_out === 0) {
              this.onData(strm.output);
              continue;
            }
            if (_flush_mode > 0 && strm.next_out > 0) {
              this.onData(strm.output.subarray(0, strm.next_out));
              strm.avail_out = 0;
              continue;
            }
            if (strm.avail_in === 0) return true;
          }
          this.err = status;
          this.msg = strm.msg || messages_default[status];
          this.ended = true;
          this.onEnd(status);
          return status === 0;
        }
        /**
        * Called once before the first low-level deflate call.
        */
        onStart(strm) {
        }
        /**
        * By default, stores data blocks in the {@link Deflate.chunks} property and glues
        * them in {@link Deflate.onEnd}. Override this handler if you need another behaviour.
        */
        onData(chunk) {
          this.chunks.push(chunk);
        }
        /**
        * Called once after you tell deflate that the input stream is
        * complete ({@link Z_FINISH}). By default, joins the collected {@link Deflate.chunks}
        * into the {@link Deflate.result} property.
        *
        * @param status deflate status. {@link Z_OK} on success, other if not.
        */
        onEnd(status) {
          if (status === 0) this.result = flattenChunks(this.chunks);
          this.chunks = [];
        }
      };
      toString = Object.prototype.toString;
      defaultOptions = {
        chunkSize: 1024 * 64,
        windowBits: 15,
        raw: false,
        dictionary: /* @__PURE__ */ new Uint8Array(0)
      };
      Inflate = class {
        /**
        * Creates a new inflator instance with the specified params. Throws an
        * exception on bad params. See {@link InflateOptions} for the list of
        * supported options.
        *
        * By default, when no options are set, the deflate/gzip data format is
        * autodetected via the wrapper header.
        *
        * @example
        * ```javascript
        * import { Inflate } from 'pako'
        *
        * const chunk1 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
        * const chunk2 = new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
        *
        * const inflate = new Inflate({ level: 3 })
        *
        * inflate.push(chunk1, false)
        * inflate.push(chunk2, true)  // true -> last chunk
        *
        * if (inflate.err) throw new Error(inflate.err)
        *
        * console.log(inflate.result)
        * ```
        */
        constructor(options = {}) {
          __publicField(this, "options");
          /**
          * Error code after inflate finishes. {@link Z_OK} on success.
          * Should be checked when broken data is possible.
          */
          __publicField(this, "err");
          /** Error message, if {@link Inflate.err} is not {@link Z_OK}. */
          __publicField(this, "msg");
          /**
          * `true` once the compressed stream has ended. A stream may end before the
          * caller's data does (trailing bytes), so check this to know when to stop
          * pushing - further {@link Inflate.push} calls are no-ops.
          */
          __publicField(this, "ended");
          __publicField(this, "started");
          /**
          * Chunks of output data, if {@link Inflate.onData} not overridden.
          * @internal
          */
          __publicField(this, "chunks");
          __publicField(this, "strm");
          /**
          * Uncompressed result, generated by default {@link Inflate.onData}
          * and {@link Inflate.onEnd} handlers. Filled after you push last chunk
          * (call {@link Inflate.push} with {@link Z_FINISH} / `true` param).
          */
          __publicField(this, "result");
          this.options = Object.assign({}, defaultOptions, options);
          const opt = this.options;
          if (opt.raw && opt.windowBits >= 0 && opt.windowBits < 16) {
            opt.windowBits = -opt.windowBits;
            if (opt.windowBits === 0) opt.windowBits = -15;
          }
          if (opt.windowBits >= 0 && opt.windowBits < 16 && !options.windowBits) opt.windowBits += 32;
          if (opt.windowBits > 15 && opt.windowBits < 48) {
            if ((opt.windowBits & 15) === 0) opt.windowBits |= 15;
          }
          this.err = 0;
          this.msg = "";
          this.ended = false;
          this.started = false;
          this.chunks = [];
          this.result = /* @__PURE__ */ new Uint8Array(0);
          this.strm = new ZStream();
          this.strm.avail_out = 0;
          let status = inflateInit2(this.strm, opt.windowBits);
          if (status !== 0) throw new Error(messages_default[status]);
          if (toString.call(opt.dictionary) === "[object ArrayBuffer]") opt.dictionary = new Uint8Array(opt.dictionary);
          const dictionary = opt.dictionary;
          if (opt.raw && dictionary.length) {
            status = inflateSetDictionary(this.strm, dictionary);
            if (status !== 0) throw new Error(messages_default[status]);
          }
        }
        /**
        * Sends input data to the inflate pipe, generating {@link Inflate.onData} calls
        * with new output chunks. Returns `true` on success. If end of stream is
        * detected, {@link Inflate.onEnd} will be called.
        *
        * `flush_mode` is not needed for normal operation, because end of stream
        * is detected automatically. Pass {@link Z_SYNC_FLUSH} to force the decoder
        * to emit all currently available output — handy when you need to decode
        * data frame-by-frame from a long-running stream.
        *
        * On failure, calls {@link Inflate.onEnd} with the error code and returns false.
        *
        * Once the stream has ended (a compressed stream may end before your data
        * does), further `push` calls are no-ops and return whether the decode
        * finished successfully. The final outcome is in {@link Inflate.result},
        * {@link Inflate.err} and {@link Inflate.msg}.
        *
        * @param flush_mode 0..6 for corresponding {@link Z_NO_FLUSH}..{@link Z_TREES}
        *   flush modes. See constants. Skipped or `false` means {@link Z_NO_FLUSH},
        *   `true` means {@link Z_FINISH}.
        *
        * @example
        * ```javascript
        * push(chunk, false) // push one of data chunks
        * ...
        * push(chunk, true)  // push last chunk
        * ```
        */
        push(data, flush_mode = false) {
          const strm = this.strm;
          const chunkSize = this.options.chunkSize;
          let status;
          let _flush_mode;
          let last_avail_out;
          if (this.ended) return this.err === 0;
          if (typeof flush_mode === "number") _flush_mode = flush_mode;
          else _flush_mode = flush_mode === true ? 4 : 0;
          if (toString.call(data) === "[object ArrayBuffer]") strm.input = new Uint8Array(data);
          else strm.input = data;
          strm.next_in = 0;
          strm.avail_in = strm.input.length;
          if (!this.started) {
            this.started = true;
            this.onStart(strm);
          }
          for (; ; ) {
            if (strm.avail_out === 0) {
              strm.output = new Uint8Array(chunkSize);
              strm.next_out = 0;
              strm.avail_out = chunkSize;
            }
            status = inflate$1(strm, _flush_mode);
            if (status === 2) {
              const dictionary = this.options.dictionary;
              if (dictionary.length) {
                status = inflateSetDictionary(strm, dictionary);
                if (status === 0) status = inflate$1(strm, _flush_mode);
                else if (status === -3) status = 2;
              }
            }
            while (strm.avail_in > 0 && status === 1 && strm.state.wrap & 2 && strm.state.flags !== 0 && strm.input[strm.next_in] !== 0) {
              inflateReset(strm);
              status = inflate$1(strm, _flush_mode);
            }
            if (status === -2 || status === -3 || status === 2 || status === -4) break;
            last_avail_out = strm.avail_out;
            if (strm.next_out) {
              if (strm.avail_out === 0 || status === 1 || _flush_mode > 0) {
                this.onData(strm.output.length === strm.next_out ? strm.output : strm.output.subarray(0, strm.next_out));
                strm.avail_out = 0;
                strm.next_out = 0;
              }
            }
            if ((status === 0 || status === -5) && last_avail_out === 0) continue;
            if (status === 1) {
              status = inflateEnd(this.strm);
              break;
            }
            if (strm.avail_in === 0) {
              if (_flush_mode === 4) {
                status = inflateEnd(this.strm);
                if (status === 0) status = -5;
                break;
              }
              return true;
            }
          }
          this.err = status;
          this.msg = strm.msg || messages_default[status];
          this.ended = true;
          this.onEnd(status);
          return status === 0;
        }
        /**
        * Called once before the first low-level inflate call.
        *
        * Override this handler to attach low-level inflate state, for example to read
        * gzip header metadata:
        *
        * ```javascript
        * import { Inflate, GZheader, zlibInflateGetHeader } from 'pako'
        *
        * const inflator = new Inflate()
        *
        * inflator.onStart = function (strm) {
        *   this.header = new GZheader()
        *   zlibInflateGetHeader(strm, this.header)
        * }
        *
        * inflator.push(data, true)
        * console.log(inflator.header.name)
        * ```
        */
        onStart(strm) {
        }
        /**
        * By default, stores data blocks in the {@link Inflate.chunks} property and glues
        * them in {@link Inflate.onEnd}. Override this handler if you need another behaviour.
        *
        * @param chunk output data.
        */
        onData(chunk) {
          this.chunks.push(chunk);
        }
        /**
        * Called after you tell inflate that the input stream is
        * complete ({@link Z_FINISH}). By default, joins the collected {@link Inflate.chunks},
        * frees memory and fills the {@link Inflate.result} property.
        *
        * @param status inflate status. {@link Z_OK} on success, other if not.
        */
        onEnd(status) {
          if (status === 0) this.result = flattenChunks(this.chunks);
          this.chunks = [];
        }
      };
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/types.js
  var init_types = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/types.js"() {
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/is-message.js
  function isMessage(arg, schema) {
    const isMessage2 = arg !== null && typeof arg == "object" && "$typeName" in arg && typeof arg.$typeName == "string";
    if (!isMessage2) {
      return false;
    }
    if (schema === void 0) {
      return true;
    }
    return schema.typeName === arg.$typeName;
  }
  var init_is_message = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/is-message.js"() {
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/descriptors.js
  var ScalarType;
  var init_descriptors = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/descriptors.js"() {
      (function(ScalarType2) {
        ScalarType2[ScalarType2["DOUBLE"] = 1] = "DOUBLE";
        ScalarType2[ScalarType2["FLOAT"] = 2] = "FLOAT";
        ScalarType2[ScalarType2["INT64"] = 3] = "INT64";
        ScalarType2[ScalarType2["UINT64"] = 4] = "UINT64";
        ScalarType2[ScalarType2["INT32"] = 5] = "INT32";
        ScalarType2[ScalarType2["FIXED64"] = 6] = "FIXED64";
        ScalarType2[ScalarType2["FIXED32"] = 7] = "FIXED32";
        ScalarType2[ScalarType2["BOOL"] = 8] = "BOOL";
        ScalarType2[ScalarType2["STRING"] = 9] = "STRING";
        ScalarType2[ScalarType2["BYTES"] = 12] = "BYTES";
        ScalarType2[ScalarType2["UINT32"] = 13] = "UINT32";
        ScalarType2[ScalarType2["SFIXED32"] = 15] = "SFIXED32";
        ScalarType2[ScalarType2["SFIXED64"] = 16] = "SFIXED64";
        ScalarType2[ScalarType2["SINT32"] = 17] = "SINT32";
        ScalarType2[ScalarType2["SINT64"] = 18] = "SINT64";
      })(ScalarType || (ScalarType = {}));
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/wire/varint.js
  function varint64read() {
    let lowBits = 0;
    let highBits = 0;
    for (let shift = 0; shift < 28; shift += 7) {
      let b = this.buf[this.pos++];
      lowBits |= (b & 127) << shift;
      if ((b & 128) == 0) {
        this.assertBounds();
        return [lowBits, highBits];
      }
    }
    let middleByte = this.buf[this.pos++];
    lowBits |= (middleByte & 15) << 28;
    highBits = (middleByte & 112) >> 4;
    if ((middleByte & 128) == 0) {
      this.assertBounds();
      return [lowBits, highBits];
    }
    for (let shift = 3; shift <= 31; shift += 7) {
      let b = this.buf[this.pos++];
      highBits |= (b & 127) << shift;
      if ((b & 128) == 0) {
        this.assertBounds();
        return [lowBits, highBits];
      }
    }
    throw new Error("invalid varint");
  }
  function varint64write(lo, hi, bytes) {
    for (let i = 0; i < 28; i = i + 7) {
      const shift = lo >>> i;
      const hasNext = !(shift >>> 7 == 0 && hi == 0);
      const byte = (hasNext ? shift | 128 : shift) & 255;
      bytes.push(byte);
      if (!hasNext) {
        return;
      }
    }
    const splitBits = lo >>> 28 & 15 | (hi & 7) << 4;
    const hasMoreBits = !(hi >> 3 == 0);
    bytes.push((hasMoreBits ? splitBits | 128 : splitBits) & 255);
    if (!hasMoreBits) {
      return;
    }
    for (let i = 3; i < 31; i = i + 7) {
      const shift = hi >>> i;
      const hasNext = !(shift >>> 7 == 0);
      const byte = (hasNext ? shift | 128 : shift) & 255;
      bytes.push(byte);
      if (!hasNext) {
        return;
      }
    }
    bytes.push(hi >>> 31 & 1);
  }
  function int64FromString(dec) {
    const minus = dec[0] === "-";
    if (minus) {
      dec = dec.slice(1);
    }
    const base = 1e6;
    let lowBits = 0;
    let highBits = 0;
    function add1e6digit(begin, end) {
      const digit1e6 = Number(dec.slice(begin, end));
      highBits *= base;
      lowBits = lowBits * base + digit1e6;
      if (lowBits >= TWO_PWR_32_DBL) {
        highBits = highBits + (lowBits / TWO_PWR_32_DBL | 0);
        lowBits = lowBits % TWO_PWR_32_DBL;
      }
    }
    add1e6digit(-24, -18);
    add1e6digit(-18, -12);
    add1e6digit(-12, -6);
    add1e6digit(-6);
    return minus ? negate(lowBits, highBits) : newBits(lowBits, highBits);
  }
  function int64ToString(lo, hi) {
    let bits = newBits(lo, hi);
    const negative = bits.hi & 2147483648;
    if (negative) {
      bits = negate(bits.lo, bits.hi);
    }
    const result = uInt64ToString(bits.lo, bits.hi);
    return negative ? "-" + result : result;
  }
  function uInt64ToString(lo, hi) {
    ({ lo, hi } = toUnsigned(lo, hi));
    if (hi <= 2097151) {
      return String(TWO_PWR_32_DBL * hi + lo);
    }
    const low = lo & 16777215;
    const mid = (lo >>> 24 | hi << 8) & 16777215;
    const high = hi >> 16 & 65535;
    let digitA = low + mid * 6777216 + high * 6710656;
    let digitB = mid + high * 8147497;
    let digitC = high * 2;
    const base = 1e7;
    if (digitA >= base) {
      digitB += Math.floor(digitA / base);
      digitA %= base;
    }
    if (digitB >= base) {
      digitC += Math.floor(digitB / base);
      digitB %= base;
    }
    return digitC.toString() + decimalFrom1e7WithLeadingZeros(digitB) + decimalFrom1e7WithLeadingZeros(digitA);
  }
  function toUnsigned(lo, hi) {
    return { lo: lo >>> 0, hi: hi >>> 0 };
  }
  function newBits(lo, hi) {
    return { lo: lo | 0, hi: hi | 0 };
  }
  function negate(lowBits, highBits) {
    highBits = ~highBits;
    if (lowBits) {
      lowBits = ~lowBits + 1;
    } else {
      highBits += 1;
    }
    return newBits(lowBits, highBits);
  }
  function varint32write(value, bytes) {
    if (value >= 0) {
      while (value > 127) {
        bytes.push(value & 127 | 128);
        value = value >>> 7;
      }
      bytes.push(value);
    } else {
      for (let i = 0; i < 9; i++) {
        bytes.push(value & 127 | 128);
        value = value >> 7;
      }
      bytes.push(1);
    }
  }
  function varint32read() {
    let b = this.buf[this.pos++];
    let result = b & 127;
    if ((b & 128) == 0) {
      this.assertBounds();
      return result;
    }
    b = this.buf[this.pos++];
    result |= (b & 127) << 7;
    if ((b & 128) == 0) {
      this.assertBounds();
      return result;
    }
    b = this.buf[this.pos++];
    result |= (b & 127) << 14;
    if ((b & 128) == 0) {
      this.assertBounds();
      return result;
    }
    b = this.buf[this.pos++];
    result |= (b & 127) << 21;
    if ((b & 128) == 0) {
      this.assertBounds();
      return result;
    }
    b = this.buf[this.pos++];
    result |= (b & 15) << 28;
    for (let readBytes = 5; (b & 128) !== 0 && readBytes < 10; readBytes++)
      b = this.buf[this.pos++];
    if ((b & 128) != 0)
      throw new Error("invalid varint");
    this.assertBounds();
    return result >>> 0;
  }
  var TWO_PWR_32_DBL, decimalFrom1e7WithLeadingZeros;
  var init_varint = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/wire/varint.js"() {
      TWO_PWR_32_DBL = 4294967296;
      decimalFrom1e7WithLeadingZeros = (digit1e7) => {
        const partial = String(digit1e7);
        return "0000000".slice(partial.length) + partial;
      };
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/proto-int64.js
  function makeInt64Support() {
    const dv = new DataView(new ArrayBuffer(8));
    const ok = typeof BigInt === "function" && typeof dv.getBigInt64 === "function" && typeof dv.getBigUint64 === "function" && typeof dv.setBigInt64 === "function" && typeof dv.setBigUint64 === "function" && (!!globalThis.Deno || !!globalThis.Bun || typeof process != "object" || typeof process.env != "object" || process.env.BUF_BIGINT_DISABLE !== "1");
    if (ok) {
      const MIN = BigInt("-9223372036854775808");
      const MAX = BigInt("9223372036854775807");
      const UMIN = BigInt("0");
      const UMAX = BigInt("18446744073709551615");
      return {
        zero: BigInt(0),
        supported: true,
        parse(value) {
          const bi = typeof value == "bigint" ? value : BigInt(value);
          if (bi > MAX || bi < MIN) {
            throw new Error(`invalid int64: ${value}`);
          }
          return bi;
        },
        uParse(value) {
          const bi = typeof value == "bigint" ? value : BigInt(value);
          if (bi > UMAX || bi < UMIN) {
            throw new Error(`invalid uint64: ${value}`);
          }
          return bi;
        },
        enc(value) {
          dv.setBigInt64(0, this.parse(value), true);
          return {
            lo: dv.getInt32(0, true),
            hi: dv.getInt32(4, true)
          };
        },
        uEnc(value) {
          dv.setBigInt64(0, this.uParse(value), true);
          return {
            lo: dv.getInt32(0, true),
            hi: dv.getInt32(4, true)
          };
        },
        dec(lo, hi) {
          dv.setInt32(0, lo, true);
          dv.setInt32(4, hi, true);
          return dv.getBigInt64(0, true);
        },
        uDec(lo, hi) {
          dv.setInt32(0, lo, true);
          dv.setInt32(4, hi, true);
          return dv.getBigUint64(0, true);
        }
      };
    }
    return {
      zero: "0",
      supported: false,
      parse(value) {
        if (typeof value != "string") {
          value = value.toString();
        }
        assertInt64String(value);
        return value;
      },
      uParse(value) {
        if (typeof value != "string") {
          value = value.toString();
        }
        assertUInt64String(value);
        return value;
      },
      enc(value) {
        if (typeof value != "string") {
          value = value.toString();
        }
        assertInt64String(value);
        return int64FromString(value);
      },
      uEnc(value) {
        if (typeof value != "string") {
          value = value.toString();
        }
        assertUInt64String(value);
        return int64FromString(value);
      },
      dec(lo, hi) {
        return int64ToString(lo, hi);
      },
      uDec(lo, hi) {
        return uInt64ToString(lo, hi);
      }
    };
  }
  function assertInt64String(value) {
    if (!/^-?[0-9]+$/.test(value)) {
      throw new Error("invalid int64: " + value);
    }
  }
  function assertUInt64String(value) {
    if (!/^[0-9]+$/.test(value)) {
      throw new Error("invalid uint64: " + value);
    }
  }
  var protoInt64;
  var init_proto_int64 = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/proto-int64.js"() {
      init_varint();
      protoInt64 = /* @__PURE__ */ makeInt64Support();
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/reflect/scalar.js
  function scalarZeroValue(type, longAsString) {
    switch (type) {
      case ScalarType.STRING:
        return "";
      case ScalarType.BOOL:
        return false;
      case ScalarType.DOUBLE:
      case ScalarType.FLOAT:
        return 0;
      case ScalarType.INT64:
      case ScalarType.UINT64:
      case ScalarType.SFIXED64:
      case ScalarType.FIXED64:
      case ScalarType.SINT64:
        return longAsString ? "0" : protoInt64.zero;
      case ScalarType.BYTES:
        return new Uint8Array(0);
      default:
        return 0;
    }
  }
  function isScalarZeroValue(type, value) {
    switch (type) {
      case ScalarType.BOOL:
        return value === false;
      case ScalarType.STRING:
        return value === "";
      case ScalarType.BYTES:
        return value instanceof Uint8Array && !value.byteLength;
      case ScalarType.DOUBLE:
      case ScalarType.FLOAT:
        return Object.is(value, 0);
      default:
        return value == 0;
    }
  }
  var init_scalar = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/reflect/scalar.js"() {
      init_proto_int64();
      init_descriptors();
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/reflect/unsafe.js
  function unsafeOneofCase(target, oneof) {
    const c = target[oneof.localName].case;
    if (c === void 0) {
      return c;
    }
    return oneof.fields.find((f) => f.localName === c);
  }
  function unsafeIsSet(target, field) {
    const name = field.localName;
    if (field.oneof) {
      return target[field.oneof.localName].case === name;
    }
    if (field.presence != IMPLICIT) {
      return target[name] !== void 0 && Object.prototype.hasOwnProperty.call(target, name);
    }
    switch (field.fieldKind) {
      case "list":
        return target[name].length > 0;
      case "map":
        return Object.keys(target[name]).length > 0;
      case "scalar":
        return !isScalarZeroValue(field.scalar, target[name]);
      case "enum":
        return target[name] !== field.enum.values[0].number;
    }
    throw new Error("message field with implicit presence");
  }
  function unsafeIsSetExplicit(target, localName) {
    return Object.prototype.hasOwnProperty.call(target, localName) && target[localName] !== void 0;
  }
  function unsafeGet(target, field) {
    if (field.oneof) {
      const oneof = target[field.oneof.localName];
      if (oneof.case === field.localName) {
        return oneof.value;
      }
      return void 0;
    }
    return target[field.localName];
  }
  function unsafeSet(target, field, value) {
    if (field.oneof) {
      target[field.oneof.localName] = {
        case: field.localName,
        value
      };
    } else {
      target[field.localName] = value;
    }
  }
  function unsafeClear(target, field) {
    const name = field.localName;
    if (field.oneof) {
      const oneofLocalName = field.oneof.localName;
      if (target[oneofLocalName].case === name) {
        target[oneofLocalName] = { case: void 0 };
      }
    } else if (field.presence != IMPLICIT) {
      delete target[name];
    } else {
      switch (field.fieldKind) {
        case "map":
          target[name] = {};
          break;
        case "list":
          target[name] = [];
          break;
        case "enum":
          target[name] = field.enum.values[0].number;
          break;
        case "scalar":
          target[name] = scalarZeroValue(field.scalar, field.longAsString);
          break;
      }
    }
  }
  var IMPLICIT, unsafeLocal;
  var init_unsafe = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/reflect/unsafe.js"() {
      init_scalar();
      IMPLICIT = 2;
      unsafeLocal = Symbol.for("reflect unsafe local");
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/reflect/guard.js
  function isObject(arg) {
    return arg !== null && typeof arg == "object" && !Array.isArray(arg);
  }
  function isReflectList(arg, field) {
    var _a, _b, _c, _d;
    if (isObject(arg) && unsafeLocal in arg && "add" in arg && "field" in arg && typeof arg.field == "function") {
      if (field !== void 0) {
        const a = field;
        const b = arg.field();
        return a.listKind == b.listKind && a.scalar === b.scalar && ((_a = a.message) === null || _a === void 0 ? void 0 : _a.typeName) === ((_b = b.message) === null || _b === void 0 ? void 0 : _b.typeName) && ((_c = a.enum) === null || _c === void 0 ? void 0 : _c.typeName) === ((_d = b.enum) === null || _d === void 0 ? void 0 : _d.typeName);
      }
      return true;
    }
    return false;
  }
  function isReflectMap(arg, field) {
    var _a, _b, _c, _d;
    if (isObject(arg) && unsafeLocal in arg && "has" in arg && "field" in arg && typeof arg.field == "function") {
      if (field !== void 0) {
        const a = field, b = arg.field();
        return a.mapKey === b.mapKey && a.mapKind == b.mapKind && a.scalar === b.scalar && ((_a = a.message) === null || _a === void 0 ? void 0 : _a.typeName) === ((_b = b.message) === null || _b === void 0 ? void 0 : _b.typeName) && ((_c = a.enum) === null || _c === void 0 ? void 0 : _c.typeName) === ((_d = b.enum) === null || _d === void 0 ? void 0 : _d.typeName);
      }
      return true;
    }
    return false;
  }
  function isReflectMessage(arg, messageDesc2) {
    return isObject(arg) && unsafeLocal in arg && "desc" in arg && isObject(arg.desc) && arg.desc.kind === "message" && (messageDesc2 === void 0 || arg.desc.typeName == messageDesc2.typeName);
  }
  var init_guard = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/reflect/guard.js"() {
      init_unsafe();
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/wkt/wrappers.js
  function isWrapper(arg) {
    return isWrapperTypeName(arg.$typeName);
  }
  function isWrapperDesc(messageDesc2) {
    const f = messageDesc2.fields[0];
    return isWrapperTypeName(messageDesc2.typeName) && f !== void 0 && f.fieldKind == "scalar" && f.name == "value" && f.number == 1;
  }
  function isWrapperTypeName(name) {
    return name.startsWith("google.protobuf.") && [
      "DoubleValue",
      "FloatValue",
      "Int64Value",
      "UInt64Value",
      "Int32Value",
      "UInt32Value",
      "BoolValue",
      "StringValue",
      "BytesValue"
    ].includes(name.substring(16));
  }
  var init_wrappers = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/wkt/wrappers.js"() {
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/create.js
  function create(schema, init) {
    if (isMessage(init, schema)) {
      return init;
    }
    const message = createZeroMessage(schema);
    if (init !== void 0) {
      initMessage(schema, message, init);
    }
    return message;
  }
  function initMessage(messageDesc2, message, init) {
    for (const member of messageDesc2.members) {
      let value = init[member.localName];
      if (value == null) {
        continue;
      }
      let field;
      if (member.kind == "oneof") {
        const oneofField = unsafeOneofCase(init, member);
        if (!oneofField) {
          continue;
        }
        field = oneofField;
        value = unsafeGet(init, oneofField);
      } else {
        field = member;
      }
      switch (field.fieldKind) {
        case "message":
          value = toMessage(field, value);
          break;
        case "scalar":
          value = initScalar(field, value);
          break;
        case "list":
          value = initList(field, value);
          break;
        case "map":
          value = initMap(field, value);
          break;
      }
      unsafeSet(message, field, value);
    }
    return message;
  }
  function initScalar(field, value) {
    if (field.scalar == ScalarType.BYTES) {
      return toU8Arr(value);
    }
    return value;
  }
  function initMap(field, value) {
    if (isObject(value)) {
      if (field.scalar == ScalarType.BYTES) {
        return convertObjectValues(value, toU8Arr);
      }
      if (field.mapKind == "message") {
        return convertObjectValues(value, (val) => toMessage(field, val));
      }
    }
    return value;
  }
  function initList(field, value) {
    if (Array.isArray(value)) {
      if (field.scalar == ScalarType.BYTES) {
        return value.map(toU8Arr);
      }
      if (field.listKind == "message") {
        return value.map((item) => toMessage(field, item));
      }
    }
    return value;
  }
  function toMessage(field, value) {
    if (field.fieldKind == "message" && !field.oneof && isWrapperDesc(field.message)) {
      return initScalar(field.message.fields[0], value);
    }
    if (isObject(value)) {
      if (field.message.typeName == "google.protobuf.Struct" && field.parent.typeName !== "google.protobuf.Value") {
        return value;
      }
      if (!isMessage(value, field.message)) {
        return create(field.message, value);
      }
    }
    return value;
  }
  function toU8Arr(value) {
    return Array.isArray(value) ? new Uint8Array(value) : value;
  }
  function convertObjectValues(obj, fn) {
    const ret = {};
    for (const entry of Object.entries(obj)) {
      ret[entry[0]] = fn(entry[1]);
    }
    return ret;
  }
  function createZeroMessage(desc) {
    let msg;
    if (!needsPrototypeChain(desc)) {
      msg = {
        $typeName: desc.typeName
      };
      for (const member of desc.members) {
        if (member.kind == "oneof" || member.presence == IMPLICIT2) {
          msg[member.localName] = createZeroField(member);
        }
      }
    } else {
      const cached = messagePrototypes.get(desc);
      let prototype;
      let members;
      if (cached) {
        ({ prototype, members } = cached);
      } else {
        prototype = {};
        members = /* @__PURE__ */ new Set();
        for (const member of desc.members) {
          if (member.kind == "oneof") {
            continue;
          }
          if (member.fieldKind != "scalar" && member.fieldKind != "enum") {
            continue;
          }
          if (member.presence == IMPLICIT2) {
            continue;
          }
          members.add(member);
          prototype[member.localName] = createZeroField(member);
        }
        messagePrototypes.set(desc, { prototype, members });
      }
      msg = Object.create(prototype);
      msg.$typeName = desc.typeName;
      for (const member of desc.members) {
        if (members.has(member)) {
          continue;
        }
        if (member.kind == "field") {
          if (member.fieldKind == "message") {
            continue;
          }
          if (member.fieldKind == "scalar" || member.fieldKind == "enum") {
            if (member.presence != IMPLICIT2) {
              continue;
            }
          }
        }
        msg[member.localName] = createZeroField(member);
      }
    }
    return msg;
  }
  function needsPrototypeChain(desc) {
    switch (desc.file.edition) {
      case EDITION_PROTO3:
        return false;
      case EDITION_PROTO2:
        return true;
      default:
        return desc.fields.some((f) => f.presence != IMPLICIT2 && f.fieldKind != "message" && !f.oneof);
    }
  }
  function createZeroField(field) {
    if (field.kind == "oneof") {
      return { case: void 0 };
    }
    if (field.fieldKind == "list") {
      return [];
    }
    if (field.fieldKind == "map") {
      return {};
    }
    if (field.fieldKind == "message") {
      return tokenZeroMessageField;
    }
    const defaultValue = field.getDefaultValue();
    if (defaultValue !== void 0) {
      return field.fieldKind == "scalar" && field.longAsString ? defaultValue.toString() : defaultValue;
    }
    return field.fieldKind == "scalar" ? scalarZeroValue(field.scalar, field.longAsString) : field.enum.values[0].number;
  }
  var EDITION_PROTO3, EDITION_PROTO2, IMPLICIT2, tokenZeroMessageField, messagePrototypes;
  var init_create = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/create.js"() {
      init_is_message();
      init_descriptors();
      init_scalar();
      init_guard();
      init_unsafe();
      init_wrappers();
      EDITION_PROTO3 = 999;
      EDITION_PROTO2 = 998;
      IMPLICIT2 = 2;
      tokenZeroMessageField = Symbol();
      messagePrototypes = /* @__PURE__ */ new WeakMap();
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/reflect/error.js
  var FieldError;
  var init_error = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/reflect/error.js"() {
      FieldError = class extends Error {
        constructor(fieldOrOneof, message, name = "FieldValueInvalidError") {
          super(message);
          this.name = name;
          this.field = () => fieldOrOneof;
        }
      };
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/wire/text-encoding.js
  function getTextEncoding() {
    if (globalThis[symbol] == void 0) {
      const te = new globalThis.TextEncoder();
      const td = new globalThis.TextDecoder();
      let tdStrict;
      globalThis[symbol] = {
        encodeUtf8(text) {
          return te.encode(text);
        },
        decodeUtf8(bytes, strict) {
          if (strict) {
            if (tdStrict === void 0) {
              tdStrict = new globalThis.TextDecoder("utf-8", { fatal: true });
            }
            return tdStrict.decode(bytes);
          }
          return td.decode(bytes);
        },
        checkUtf8(text) {
          try {
            encodeURIComponent(text);
            return true;
          } catch (_) {
            return false;
          }
        }
      };
    }
    return globalThis[symbol];
  }
  var symbol;
  var init_text_encoding = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/wire/text-encoding.js"() {
      symbol = Symbol.for("@bufbuild/protobuf/text-encoding");
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/wire/binary-encoding.js
  function assertInt32(arg) {
    if (typeof arg == "string") {
      arg = Number(arg);
    } else if (typeof arg != "number") {
      throw new Error("invalid int32: " + typeof arg);
    }
    if (!Number.isInteger(arg) || arg > INT32_MAX || arg < INT32_MIN)
      throw new Error("invalid int32: " + arg);
  }
  function assertUInt32(arg) {
    if (typeof arg == "string") {
      arg = Number(arg);
    } else if (typeof arg != "number") {
      throw new Error("invalid uint32: " + typeof arg);
    }
    if (!Number.isInteger(arg) || arg > UINT32_MAX || arg < 0)
      throw new Error("invalid uint32: " + arg);
  }
  function assertFloat32(arg) {
    if (typeof arg == "string") {
      const o = arg;
      arg = Number(arg);
      if (Number.isNaN(arg) && o !== "NaN") {
        throw new Error("invalid float32: " + o);
      }
    } else if (typeof arg != "number") {
      throw new Error("invalid float32: " + typeof arg);
    }
    if (Number.isFinite(arg) && (arg > FLOAT32_MAX || arg < FLOAT32_MIN))
      throw new Error("invalid float32: " + arg);
  }
  var WireType, FLOAT32_MAX, FLOAT32_MIN, UINT32_MAX, INT32_MAX, INT32_MIN, BinaryWriter, BinaryReader;
  var init_binary_encoding = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/wire/binary-encoding.js"() {
      init_varint();
      init_proto_int64();
      init_text_encoding();
      (function(WireType2) {
        WireType2[WireType2["Varint"] = 0] = "Varint";
        WireType2[WireType2["Bit64"] = 1] = "Bit64";
        WireType2[WireType2["LengthDelimited"] = 2] = "LengthDelimited";
        WireType2[WireType2["StartGroup"] = 3] = "StartGroup";
        WireType2[WireType2["EndGroup"] = 4] = "EndGroup";
        WireType2[WireType2["Bit32"] = 5] = "Bit32";
      })(WireType || (WireType = {}));
      FLOAT32_MAX = 34028234663852886e22;
      FLOAT32_MIN = -34028234663852886e22;
      UINT32_MAX = 4294967295;
      INT32_MAX = 2147483647;
      INT32_MIN = -2147483648;
      BinaryWriter = class {
        constructor(encodeUtf8 = getTextEncoding().encodeUtf8) {
          this.encodeUtf8 = encodeUtf8;
          this.stack = [];
          this.chunks = [];
          this.buf = [];
        }
        /**
         * Return all bytes written and reset this writer.
         */
        finish() {
          if (this.buf.length) {
            this.chunks.push(new Uint8Array(this.buf));
            this.buf = [];
          }
          let len = 0;
          for (let i = 0; i < this.chunks.length; i++)
            len += this.chunks[i].length;
          let bytes = new Uint8Array(len);
          let offset = 0;
          for (let i = 0; i < this.chunks.length; i++) {
            bytes.set(this.chunks[i], offset);
            offset += this.chunks[i].length;
          }
          this.chunks = [];
          return bytes;
        }
        /**
         * Start a new fork for length-delimited data like a message
         * or a packed repeated field.
         *
         * Must be joined later with `join()`.
         */
        fork() {
          this.stack.push({ chunks: this.chunks, buf: this.buf });
          this.chunks = [];
          this.buf = [];
          return this;
        }
        /**
         * Join the last fork. Write its length and bytes, then
         * return to the previous state.
         */
        join() {
          let chunk = this.finish();
          let prev = this.stack.pop();
          if (!prev)
            throw new Error("invalid state, fork stack empty");
          this.chunks = prev.chunks;
          this.buf = prev.buf;
          this.uint32(chunk.byteLength);
          return this.raw(chunk);
        }
        /**
         * Writes a tag (field number and wire type).
         *
         * Equivalent to `uint32( (fieldNo << 3 | type) >>> 0 )`.
         *
         * Generated code should compute the tag ahead of time and call `uint32()`.
         */
        tag(fieldNo, type) {
          return this.uint32((fieldNo << 3 | type) >>> 0);
        }
        /**
         * Write a chunk of raw bytes.
         */
        raw(chunk) {
          if (this.buf.length) {
            this.chunks.push(new Uint8Array(this.buf));
            this.buf = [];
          }
          this.chunks.push(chunk);
          return this;
        }
        /**
         * Write a `uint32` value, an unsigned 32 bit varint.
         */
        uint32(value) {
          assertUInt32(value);
          while (value > 127) {
            this.buf.push(value & 127 | 128);
            value = value >>> 7;
          }
          this.buf.push(value);
          return this;
        }
        /**
         * Write a `int32` value, a signed 32 bit varint.
         */
        int32(value) {
          assertInt32(value);
          varint32write(value, this.buf);
          return this;
        }
        /**
         * Write a `bool` value, a varint.
         */
        bool(value) {
          this.buf.push(value ? 1 : 0);
          return this;
        }
        /**
         * Write a `bytes` value, length-delimited arbitrary data.
         */
        bytes(value) {
          this.uint32(value.byteLength);
          return this.raw(value);
        }
        /**
         * Write a `string` value, length-delimited data converted to UTF-8 text.
         */
        string(value) {
          let chunk = this.encodeUtf8(value);
          this.uint32(chunk.byteLength);
          return this.raw(chunk);
        }
        /**
         * Write a `float` value, 32-bit floating point number.
         */
        float(value) {
          assertFloat32(value);
          let chunk = new Uint8Array(4);
          new DataView(chunk.buffer).setFloat32(0, value, true);
          return this.raw(chunk);
        }
        /**
         * Write a `double` value, a 64-bit floating point number.
         */
        double(value) {
          let chunk = new Uint8Array(8);
          new DataView(chunk.buffer).setFloat64(0, value, true);
          return this.raw(chunk);
        }
        /**
         * Write a `fixed32` value, an unsigned, fixed-length 32-bit integer.
         */
        fixed32(value) {
          assertUInt32(value);
          let chunk = new Uint8Array(4);
          new DataView(chunk.buffer).setUint32(0, value, true);
          return this.raw(chunk);
        }
        /**
         * Write a `sfixed32` value, a signed, fixed-length 32-bit integer.
         */
        sfixed32(value) {
          assertInt32(value);
          let chunk = new Uint8Array(4);
          new DataView(chunk.buffer).setInt32(0, value, true);
          return this.raw(chunk);
        }
        /**
         * Write a `sint32` value, a signed, zigzag-encoded 32-bit varint.
         */
        sint32(value) {
          assertInt32(value);
          value = (value << 1 ^ value >> 31) >>> 0;
          varint32write(value, this.buf);
          return this;
        }
        /**
         * Write a `sfixed64` value, a signed, fixed-length 64-bit integer.
         */
        sfixed64(value) {
          let chunk = new Uint8Array(8), view = new DataView(chunk.buffer), tc = protoInt64.enc(value);
          view.setInt32(0, tc.lo, true);
          view.setInt32(4, tc.hi, true);
          return this.raw(chunk);
        }
        /**
         * Write a `fixed64` value, an unsigned, fixed-length 64 bit integer.
         */
        fixed64(value) {
          let chunk = new Uint8Array(8), view = new DataView(chunk.buffer), tc = protoInt64.uEnc(value);
          view.setInt32(0, tc.lo, true);
          view.setInt32(4, tc.hi, true);
          return this.raw(chunk);
        }
        /**
         * Write a `int64` value, a signed 64-bit varint.
         */
        int64(value) {
          let tc = protoInt64.enc(value);
          varint64write(tc.lo, tc.hi, this.buf);
          return this;
        }
        /**
         * Write a `sint64` value, a signed, zig-zag-encoded 64-bit varint.
         */
        sint64(value) {
          const tc = protoInt64.enc(value), sign = tc.hi >> 31, lo = tc.lo << 1 ^ sign, hi = (tc.hi << 1 | tc.lo >>> 31) ^ sign;
          varint64write(lo, hi, this.buf);
          return this;
        }
        /**
         * Write a `uint64` value, an unsigned 64-bit varint.
         */
        uint64(value) {
          const tc = protoInt64.uEnc(value);
          varint64write(tc.lo, tc.hi, this.buf);
          return this;
        }
      };
      BinaryReader = class {
        constructor(buf, decodeUtf8 = getTextEncoding().decodeUtf8) {
          this.decodeUtf8 = decodeUtf8;
          this.varint64 = varint64read;
          this.uint32 = varint32read;
          this.buf = buf;
          this.len = buf.length;
          this.pos = 0;
          this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        }
        /**
         * Reads a tag - field number and wire type. Tags are uint32 varints; values
         * that do not fit in uint32 are rejected.
         */
        tag() {
          const start = this.pos;
          const tag = this.uint32();
          const bytesRead = this.pos - start;
          if (bytesRead > 5 || bytesRead == 5 && this.buf[this.pos - 1] > 15) {
            throw new Error("illegal tag: varint overflows uint32");
          }
          const fieldNo = tag >>> 3;
          const wireType = tag & 7;
          if (fieldNo <= 0 || wireType > 5) {
            throw new Error("illegal tag: field no " + fieldNo + " wire type " + wireType);
          }
          return [fieldNo, wireType];
        }
        /**
         * Skip one element and return the skipped data.
         *
         * When skipping StartGroup, provide the tags field number to check for
         * matching field number in the EndGroup tag. Recursion into nested groups
         * is guarded by the `recursionLimit` argument: When the limit is reached,
         * this method throws.
         */
        skip(wireType, fieldNo, recursionLimit = 100) {
          let start = this.pos;
          switch (wireType) {
            case WireType.Varint:
              while (this.buf[this.pos++] & 128) {
              }
              break;
            // @ts-ignore TS7029: Fallthrough case in switch -- ignore instead of expect-error for compiler settings without noFallthroughCasesInSwitch: true
            case WireType.Bit64:
              this.pos += 4;
            case WireType.Bit32:
              this.pos += 4;
              break;
            case WireType.LengthDelimited:
              let len = this.uint32();
              this.pos += len;
              break;
            case WireType.StartGroup:
              if (recursionLimit <= 0) {
                throw new Error("maximum recursion depth reached");
              }
              for (; ; ) {
                const [fn, wt] = this.tag();
                if (wt === WireType.EndGroup) {
                  if (fieldNo !== void 0 && fn !== fieldNo) {
                    throw new Error("invalid end group tag");
                  }
                  break;
                }
                this.skip(wt, fn, recursionLimit - 1);
              }
              break;
            default:
              throw new Error("cant skip wire type " + wireType);
          }
          this.assertBounds();
          return this.buf.subarray(start, this.pos);
        }
        /**
         * Throws error if position in byte array is out of range.
         */
        assertBounds() {
          if (this.pos > this.len)
            throw new RangeError("premature EOF");
        }
        /**
         * Read a `int32` field, a signed 32 bit varint.
         */
        int32() {
          return this.uint32() | 0;
        }
        /**
         * Read a `sint32` field, a signed, zigzag-encoded 32-bit varint.
         */
        sint32() {
          let zze = this.uint32();
          return zze >>> 1 ^ -(zze & 1);
        }
        /**
         * Read a `int64` field, a signed 64-bit varint.
         */
        int64() {
          return protoInt64.dec(...this.varint64());
        }
        /**
         * Read a `uint64` field, an unsigned 64-bit varint.
         */
        uint64() {
          return protoInt64.uDec(...this.varint64());
        }
        /**
         * Read a `sint64` field, a signed, zig-zag-encoded 64-bit varint.
         */
        sint64() {
          let [lo, hi] = this.varint64();
          let s = -(lo & 1);
          lo = (lo >>> 1 | (hi & 1) << 31) ^ s;
          hi = hi >>> 1 ^ s;
          return protoInt64.dec(lo, hi);
        }
        /**
         * Read a `bool` field, a variant.
         */
        bool() {
          let [lo, hi] = this.varint64();
          return lo !== 0 || hi !== 0;
        }
        /**
         * Read a `fixed32` field, an unsigned, fixed-length 32-bit integer.
         */
        fixed32() {
          return this.view.getUint32((this.pos += 4) - 4, true);
        }
        /**
         * Read a `sfixed32` field, a signed, fixed-length 32-bit integer.
         */
        sfixed32() {
          return this.view.getInt32((this.pos += 4) - 4, true);
        }
        /**
         * Read a `fixed64` field, an unsigned, fixed-length 64 bit integer.
         */
        fixed64() {
          return protoInt64.uDec(this.sfixed32(), this.sfixed32());
        }
        /**
         * Read a `fixed64` field, a signed, fixed-length 64-bit integer.
         */
        sfixed64() {
          return protoInt64.dec(this.sfixed32(), this.sfixed32());
        }
        /**
         * Read a `float` field, 32-bit floating point number.
         */
        float() {
          return this.view.getFloat32((this.pos += 4) - 4, true);
        }
        /**
         * Read a `double` field, a 64-bit floating point number.
         */
        double() {
          return this.view.getFloat64((this.pos += 8) - 8, true);
        }
        /**
         * Read a `bytes` field, length-delimited arbitrary data.
         */
        bytes() {
          let len = this.uint32(), start = this.pos;
          this.pos += len;
          this.assertBounds();
          return this.buf.subarray(start, start + len);
        }
        /**
         * Read a `string` field, length-delimited data converted to UTF-8 text. If
         * `strict` is true, throw on invalid UTF-8 instead of substituting U+FFFD.
         */
        string(strict) {
          return this.decodeUtf8(this.bytes(), strict);
        }
      };
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/reflect/reflect-check.js
  function checkField(field, value) {
    const check = field.fieldKind == "list" ? isReflectList(value, field) : field.fieldKind == "map" ? isReflectMap(value, field) : checkSingular(field, value);
    if (check === true) {
      return void 0;
    }
    let reason;
    switch (field.fieldKind) {
      case "list":
        reason = `expected ${formatReflectList(field)}, got ${formatVal(value)}`;
        break;
      case "map":
        reason = `expected ${formatReflectMap(field)}, got ${formatVal(value)}`;
        break;
      default: {
        reason = reasonSingular(field, value, check);
      }
    }
    return new FieldError(field, reason);
  }
  function checkListItem(field, index, value) {
    const check = checkSingular(field, value);
    if (check !== true) {
      return new FieldError(field, `list item #${index + 1}: ${reasonSingular(field, value, check)}`);
    }
    return void 0;
  }
  function checkMapEntry(field, key, value) {
    const checkKey = checkScalarValue(key, field.mapKey);
    if (checkKey !== true) {
      return new FieldError(field, `invalid map key: ${reasonSingular({ scalar: field.mapKey }, key, checkKey)}`);
    }
    const checkVal = checkSingular(field, value);
    if (checkVal !== true) {
      return new FieldError(field, `map entry ${formatVal(key)}: ${reasonSingular(field, value, checkVal)}`);
    }
    return void 0;
  }
  function checkSingular(field, value) {
    if (field.scalar !== void 0) {
      return checkScalarValue(value, field.scalar);
    }
    if (field.enum !== void 0) {
      if (field.enum.open) {
        return checkScalarValue(value, ScalarType.INT32);
      }
      return field.enum.values.some((v) => v.number === value);
    }
    return isReflectMessage(value, field.message);
  }
  function checkScalarValue(value, scalar) {
    switch (scalar) {
      case ScalarType.DOUBLE:
        return typeof value == "number";
      case ScalarType.FLOAT:
        if (typeof value != "number") {
          return false;
        }
        if (Number.isNaN(value) || !Number.isFinite(value)) {
          return true;
        }
        if (value > FLOAT32_MAX || value < FLOAT32_MIN) {
          return `${value.toFixed()} out of range`;
        }
        return true;
      case ScalarType.INT32:
      case ScalarType.SFIXED32:
      case ScalarType.SINT32:
        if (typeof value !== "number" || !Number.isInteger(value)) {
          return false;
        }
        if (value > INT32_MAX || value < INT32_MIN) {
          return `${value.toFixed()} out of range`;
        }
        return true;
      case ScalarType.FIXED32:
      case ScalarType.UINT32:
        if (typeof value !== "number" || !Number.isInteger(value)) {
          return false;
        }
        if (value > UINT32_MAX || value < 0) {
          return `${value.toFixed()} out of range`;
        }
        return true;
      case ScalarType.BOOL:
        return typeof value == "boolean";
      case ScalarType.STRING:
        if (typeof value != "string") {
          return false;
        }
        return getTextEncoding().checkUtf8(value) || "invalid UTF8";
      case ScalarType.BYTES:
        return value instanceof Uint8Array;
      case ScalarType.INT64:
      case ScalarType.SFIXED64:
      case ScalarType.SINT64:
        if (typeof value == "bigint" || typeof value == "number" || typeof value == "string" && value.length > 0) {
          try {
            protoInt64.parse(value);
            return true;
          } catch (_) {
            return `${value} out of range`;
          }
        }
        return false;
      case ScalarType.FIXED64:
      case ScalarType.UINT64:
        if (typeof value == "bigint" || typeof value == "number" || typeof value == "string" && value.length > 0) {
          try {
            protoInt64.uParse(value);
            return true;
          } catch (_) {
            return `${value} out of range`;
          }
        }
        return false;
    }
  }
  function reasonSingular(field, val, details) {
    details = typeof details == "string" ? `: ${details}` : `, got ${formatVal(val)}`;
    if (field.scalar !== void 0) {
      return `expected ${scalarTypeDescription(field.scalar)}` + details;
    }
    if (field.enum !== void 0) {
      return `expected ${field.enum.toString()}` + details;
    }
    return `expected ${formatReflectMessage(field.message)}` + details;
  }
  function formatVal(val) {
    switch (typeof val) {
      case "object":
        if (val === null) {
          return "null";
        }
        if (val instanceof Uint8Array) {
          return `Uint8Array(${val.length})`;
        }
        if (Array.isArray(val)) {
          return `Array(${val.length})`;
        }
        if (isReflectList(val)) {
          return formatReflectList(val.field());
        }
        if (isReflectMap(val)) {
          return formatReflectMap(val.field());
        }
        if (isReflectMessage(val)) {
          return formatReflectMessage(val.desc);
        }
        if (isMessage(val)) {
          return `message ${val.$typeName}`;
        }
        return "object";
      case "string":
        return val.length > 30 ? "string" : `"${val.split('"').join('\\"')}"`;
      case "boolean":
        return String(val);
      case "number":
        return String(val);
      case "bigint":
        return String(val) + "n";
      default:
        return typeof val;
    }
  }
  function formatReflectMessage(desc) {
    return `ReflectMessage (${desc.typeName})`;
  }
  function formatReflectList(field) {
    switch (field.listKind) {
      case "message":
        return `ReflectList (${field.message.toString()})`;
      case "enum":
        return `ReflectList (${field.enum.toString()})`;
      case "scalar":
        return `ReflectList (${ScalarType[field.scalar]})`;
    }
  }
  function formatReflectMap(field) {
    switch (field.mapKind) {
      case "message":
        return `ReflectMap (${ScalarType[field.mapKey]}, ${field.message.toString()})`;
      case "enum":
        return `ReflectMap (${ScalarType[field.mapKey]}, ${field.enum.toString()})`;
      case "scalar":
        return `ReflectMap (${ScalarType[field.mapKey]}, ${ScalarType[field.scalar]})`;
    }
  }
  function scalarTypeDescription(scalar) {
    switch (scalar) {
      case ScalarType.STRING:
        return "string";
      case ScalarType.BOOL:
        return "boolean";
      case ScalarType.INT64:
      case ScalarType.SINT64:
      case ScalarType.SFIXED64:
        return "bigint (int64)";
      case ScalarType.UINT64:
      case ScalarType.FIXED64:
        return "bigint (uint64)";
      case ScalarType.BYTES:
        return "Uint8Array";
      case ScalarType.DOUBLE:
        return "number (float64)";
      case ScalarType.FLOAT:
        return "number (float32)";
      case ScalarType.FIXED32:
      case ScalarType.UINT32:
        return "number (uint32)";
      case ScalarType.INT32:
      case ScalarType.SFIXED32:
      case ScalarType.SINT32:
        return "number (int32)";
    }
  }
  var init_reflect_check = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/reflect/reflect-check.js"() {
      init_descriptors();
      init_is_message();
      init_error();
      init_guard();
      init_binary_encoding();
      init_text_encoding();
      init_proto_int64();
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/reflect/reflect.js
  function reflect(messageDesc2, message, check = true) {
    return new ReflectMessageImpl(messageDesc2, message, check);
  }
  function assertOwn(owner, member) {
    if (member.parent.typeName !== owner.$typeName) {
      throw new FieldError(member, `cannot use ${member.toString()} with message ${owner.$typeName}`, "ForeignFieldError");
    }
  }
  function messageToLocal(field, value) {
    if (!isReflectMessage(value)) {
      return value;
    }
    if (isWrapper(value.message) && !field.oneof && field.fieldKind == "message") {
      return value.message.value;
    }
    if (value.desc.typeName == "google.protobuf.Struct" && field.parent.typeName != "google.protobuf.Value") {
      return wktStructToLocal(value.message);
    }
    return value.message;
  }
  function messageToReflect(field, value, check) {
    if (value !== void 0) {
      if (isWrapperDesc(field.message) && !field.oneof && field.fieldKind == "message") {
        value = {
          $typeName: field.message.typeName,
          value: longToReflect(field.message.fields[0], value)
        };
      } else if (field.message.typeName == "google.protobuf.Struct" && field.parent.typeName != "google.protobuf.Value" && isObject(value)) {
        value = wktStructToReflect(value);
      }
    }
    return new ReflectMessageImpl(field.message, value, check);
  }
  function listItemToLocal(field, value) {
    if (field.listKind == "message") {
      return messageToLocal(field, value);
    }
    return longToLocal(field, value);
  }
  function listItemToReflect(field, value, check) {
    if (field.listKind == "message") {
      return messageToReflect(field, value, check);
    }
    return longToReflect(field, value);
  }
  function mapValueToLocal(field, value) {
    if (field.mapKind == "message") {
      return messageToLocal(field, value);
    }
    return longToLocal(field, value);
  }
  function mapValueToReflect(field, value, check) {
    if (field.mapKind == "message") {
      return messageToReflect(field, value, check);
    }
    return value;
  }
  function mapKeyToLocal(key) {
    return typeof key == "string" || typeof key == "number" ? key : String(key);
  }
  function mapKeyToReflect(key, type) {
    switch (type) {
      case ScalarType.STRING:
        return key;
      case ScalarType.INT32:
      case ScalarType.FIXED32:
      case ScalarType.UINT32:
      case ScalarType.SFIXED32:
      case ScalarType.SINT32: {
        const n = Number.parseInt(key);
        if (Number.isFinite(n)) {
          return n;
        }
        break;
      }
      case ScalarType.BOOL:
        switch (key) {
          case "true":
            return true;
          case "false":
            return false;
        }
        break;
      case ScalarType.UINT64:
      case ScalarType.FIXED64:
        try {
          return protoInt64.uParse(key);
        } catch (_a) {
        }
        break;
      default:
        try {
          return protoInt64.parse(key);
        } catch (_b) {
        }
        break;
    }
    return key;
  }
  function longToReflect(field, value) {
    switch (field.scalar) {
      case ScalarType.INT64:
      case ScalarType.SFIXED64:
      case ScalarType.SINT64:
        if ("longAsString" in field && field.longAsString && typeof value == "string") {
          value = protoInt64.parse(value);
        }
        break;
      case ScalarType.FIXED64:
      case ScalarType.UINT64:
        if ("longAsString" in field && field.longAsString && typeof value == "string") {
          value = protoInt64.uParse(value);
        }
        break;
    }
    return value;
  }
  function longToLocal(field, value) {
    switch (field.scalar) {
      case ScalarType.INT64:
      case ScalarType.SFIXED64:
      case ScalarType.SINT64:
        if ("longAsString" in field && field.longAsString) {
          value = String(value);
        } else if (typeof value == "string" || typeof value == "number") {
          value = protoInt64.parse(value);
        }
        break;
      case ScalarType.FIXED64:
      case ScalarType.UINT64:
        if ("longAsString" in field && field.longAsString) {
          value = String(value);
        } else if (typeof value == "string" || typeof value == "number") {
          value = protoInt64.uParse(value);
        }
        break;
    }
    return value;
  }
  function wktStructToReflect(json) {
    const struct = {
      $typeName: "google.protobuf.Struct",
      fields: {}
    };
    if (isObject(json)) {
      for (const [k, v] of Object.entries(json)) {
        struct.fields[k] = wktValueToReflect(v);
      }
    }
    return struct;
  }
  function wktStructToLocal(val) {
    const json = {};
    for (const [k, v] of Object.entries(val.fields)) {
      json[k] = wktValueToLocal(v);
    }
    return json;
  }
  function wktValueToLocal(val) {
    switch (val.kind.case) {
      case "structValue":
        return wktStructToLocal(val.kind.value);
      case "listValue":
        return val.kind.value.values.map(wktValueToLocal);
      case "nullValue":
      case void 0:
        return null;
      default:
        return val.kind.value;
    }
  }
  function wktValueToReflect(json) {
    const value = {
      $typeName: "google.protobuf.Value",
      kind: { case: void 0 }
    };
    switch (typeof json) {
      case "number":
        value.kind = { case: "numberValue", value: json };
        break;
      case "string":
        value.kind = { case: "stringValue", value: json };
        break;
      case "boolean":
        value.kind = { case: "boolValue", value: json };
        break;
      case "object":
        if (json === null) {
          const nullValue = 0;
          value.kind = { case: "nullValue", value: nullValue };
        } else if (Array.isArray(json)) {
          const listValue = {
            $typeName: "google.protobuf.ListValue",
            values: []
          };
          if (Array.isArray(json)) {
            for (const e of json) {
              listValue.values.push(wktValueToReflect(e));
            }
          }
          value.kind = {
            case: "listValue",
            value: listValue
          };
        } else {
          value.kind = {
            case: "structValue",
            value: wktStructToReflect(json)
          };
        }
        break;
    }
    return value;
  }
  var messageSortedFields, ReflectMessageImpl, ReflectListImpl, ReflectMapImpl;
  var init_reflect = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/reflect/reflect.js"() {
      init_descriptors();
      init_reflect_check();
      init_error();
      init_unsafe();
      init_create();
      init_wrappers();
      init_scalar();
      init_proto_int64();
      init_guard();
      messageSortedFields = /* @__PURE__ */ new WeakMap();
      ReflectMessageImpl = class {
        get sortedFields() {
          const cached = messageSortedFields.get(this.desc);
          if (cached) {
            return cached;
          }
          const sortedFields = this.desc.fields.concat().sort((a, b) => a.number - b.number);
          messageSortedFields.set(this.desc, sortedFields);
          return sortedFields;
        }
        constructor(messageDesc2, message, check = true) {
          this.lists = /* @__PURE__ */ new Map();
          this.maps = /* @__PURE__ */ new Map();
          this.check = check;
          this.desc = messageDesc2;
          this.message = this[unsafeLocal] = message !== null && message !== void 0 ? message : create(messageDesc2);
          this.fields = messageDesc2.fields;
          this.oneofs = messageDesc2.oneofs;
          this.members = messageDesc2.members;
        }
        findNumber(number) {
          if (!this._fieldsByNumber) {
            this._fieldsByNumber = new Map(this.desc.fields.map((f) => [f.number, f]));
          }
          return this._fieldsByNumber.get(number);
        }
        oneofCase(oneof) {
          assertOwn(this.message, oneof);
          return unsafeOneofCase(this.message, oneof);
        }
        isSet(field) {
          assertOwn(this.message, field);
          return unsafeIsSet(this.message, field);
        }
        clear(field) {
          assertOwn(this.message, field);
          unsafeClear(this.message, field);
        }
        get(field) {
          assertOwn(this.message, field);
          const value = unsafeGet(this.message, field);
          switch (field.fieldKind) {
            case "list":
              let list = this.lists.get(field);
              if (!list || list[unsafeLocal] !== value) {
                this.lists.set(
                  field,
                  // biome-ignore lint/suspicious/noAssignInExpressions: no
                  list = new ReflectListImpl(field, value, this.check)
                );
              }
              return list;
            case "map":
              let map = this.maps.get(field);
              if (!map || map[unsafeLocal] !== value) {
                this.maps.set(
                  field,
                  // biome-ignore lint/suspicious/noAssignInExpressions: no
                  map = new ReflectMapImpl(field, value, this.check)
                );
              }
              return map;
            case "message":
              return messageToReflect(field, value, this.check);
            case "scalar":
              return value === void 0 ? scalarZeroValue(field.scalar, false) : longToReflect(field, value);
            case "enum":
              return value !== null && value !== void 0 ? value : field.enum.values[0].number;
          }
        }
        set(field, value) {
          assertOwn(this.message, field);
          if (this.check) {
            const err2 = checkField(field, value);
            if (err2) {
              throw err2;
            }
          }
          let local;
          if (field.fieldKind == "message") {
            local = messageToLocal(field, value);
          } else if (isReflectMap(value) || isReflectList(value)) {
            local = value[unsafeLocal];
          } else {
            local = longToLocal(field, value);
          }
          unsafeSet(this.message, field, local);
        }
        getUnknown() {
          return this.message.$unknown;
        }
        setUnknown(value) {
          this.message.$unknown = value;
        }
      };
      ReflectListImpl = class {
        field() {
          return this._field;
        }
        get size() {
          return this._arr.length;
        }
        constructor(field, unsafeInput, check) {
          this._field = field;
          this._arr = this[unsafeLocal] = unsafeInput;
          this.check = check;
        }
        get(index) {
          const item = this._arr[index];
          return item === void 0 ? void 0 : listItemToReflect(this._field, item, this.check);
        }
        set(index, item) {
          if (index < 0 || index >= this._arr.length) {
            throw new FieldError(this._field, `list item #${index + 1}: out of range`);
          }
          if (this.check) {
            const err2 = checkListItem(this._field, index, item);
            if (err2) {
              throw err2;
            }
          }
          this._arr[index] = listItemToLocal(this._field, item);
        }
        add(item) {
          if (this.check) {
            const err2 = checkListItem(this._field, this._arr.length, item);
            if (err2) {
              throw err2;
            }
          }
          this._arr.push(listItemToLocal(this._field, item));
          return void 0;
        }
        clear() {
          this._arr.splice(0, this._arr.length);
        }
        [Symbol.iterator]() {
          return this.values();
        }
        keys() {
          return this._arr.keys();
        }
        *values() {
          for (const item of this._arr) {
            yield listItemToReflect(this._field, item, this.check);
          }
        }
        *entries() {
          for (let i = 0; i < this._arr.length; i++) {
            yield [i, listItemToReflect(this._field, this._arr[i], this.check)];
          }
        }
      };
      ReflectMapImpl = class {
        constructor(field, unsafeInput, check = true) {
          this.obj = this[unsafeLocal] = unsafeInput !== null && unsafeInput !== void 0 ? unsafeInput : {};
          this.check = check;
          this._field = field;
        }
        field() {
          return this._field;
        }
        set(key, value) {
          if (this.check) {
            const err2 = checkMapEntry(this._field, key, value);
            if (err2) {
              throw err2;
            }
          }
          this.obj[mapKeyToLocal(key)] = mapValueToLocal(this._field, value);
          return this;
        }
        delete(key) {
          const k = mapKeyToLocal(key);
          const has = Object.prototype.hasOwnProperty.call(this.obj, k);
          if (has) {
            delete this.obj[k];
          }
          return has;
        }
        clear() {
          for (const key of Object.keys(this.obj)) {
            delete this.obj[key];
          }
        }
        get(key) {
          let val = this.obj[mapKeyToLocal(key)];
          if (val !== void 0) {
            val = mapValueToReflect(this._field, val, this.check);
          }
          return val;
        }
        has(key) {
          return Object.prototype.hasOwnProperty.call(this.obj, mapKeyToLocal(key));
        }
        *keys() {
          for (const objKey of Object.keys(this.obj)) {
            yield mapKeyToReflect(objKey, this._field.mapKey);
          }
        }
        *entries() {
          for (const objEntry of Object.entries(this.obj)) {
            yield [
              mapKeyToReflect(objEntry[0], this._field.mapKey),
              mapValueToReflect(this._field, objEntry[1], this.check)
            ];
          }
        }
        [Symbol.iterator]() {
          return this.entries();
        }
        get size() {
          return Object.keys(this.obj).length;
        }
        *values() {
          for (const val of Object.values(this.obj)) {
            yield mapValueToReflect(this._field, val, this.check);
          }
        }
        forEach(callbackfn, thisArg) {
          for (const mapEntry of this.entries()) {
            callbackfn.call(thisArg, mapEntry[1], mapEntry[0], this);
          }
        }
      };
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/clone.js
  function clone(schema, message) {
    return cloneReflect(reflect(schema, message)).message;
  }
  function cloneReflect(i) {
    const o = reflect(i.desc);
    for (const f of i.fields) {
      if (!i.isSet(f)) {
        continue;
      }
      switch (f.fieldKind) {
        case "list":
          const list = o.get(f);
          for (const item of i.get(f)) {
            list.add(cloneSingular(f, item));
          }
          break;
        case "map":
          const map = o.get(f);
          for (const entry of i.get(f).entries()) {
            map.set(entry[0], cloneSingular(f, entry[1]));
          }
          break;
        default: {
          o.set(f, cloneSingular(f, i.get(f)));
          break;
        }
      }
    }
    const unknown = i.getUnknown();
    if (unknown && unknown.length > 0) {
      o.setUnknown([...unknown]);
    }
    return o;
  }
  function cloneSingular(field, value) {
    if (field.message !== void 0 && isReflectMessage(value)) {
      return cloneReflect(value);
    }
    if (field.scalar == ScalarType.BYTES && value instanceof Uint8Array) {
      return value.slice();
    }
    return value;
  }
  var init_clone = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/clone.js"() {
      init_descriptors();
      init_reflect();
      init_guard();
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/wire/base64-encoding.js
  function base64Decode(base64Str) {
    const table = getDecodeTable();
    let es = base64Str.length * 3 / 4;
    if (base64Str[base64Str.length - 2] == "=")
      es -= 2;
    else if (base64Str[base64Str.length - 1] == "=")
      es -= 1;
    let bytes = new Uint8Array(es), bytePos = 0, groupPos = 0, b, p = 0;
    for (let i = 0; i < base64Str.length; i++) {
      b = table[base64Str.charCodeAt(i)];
      if (b === void 0) {
        switch (base64Str[i]) {
          // @ts-ignore TS7029: Fallthrough case in switch -- ignore instead of expect-error for compiler settings without noFallthroughCasesInSwitch: true
          case "=":
            groupPos = 0;
          // reset state when padding found
          case "\n":
          case "\r":
          case "	":
          case " ":
            continue;
          // skip white-space, and padding
          default:
            throw Error("invalid base64 string");
        }
      }
      switch (groupPos) {
        case 0:
          p = b;
          groupPos = 1;
          break;
        case 1:
          bytes[bytePos++] = p << 2 | (b & 48) >> 4;
          p = b;
          groupPos = 2;
          break;
        case 2:
          bytes[bytePos++] = (p & 15) << 4 | (b & 60) >> 2;
          p = b;
          groupPos = 3;
          break;
        case 3:
          bytes[bytePos++] = (p & 3) << 6 | b;
          groupPos = 0;
          break;
      }
    }
    if (groupPos == 1)
      throw Error("invalid base64 string");
    return bytes.subarray(0, bytePos);
  }
  function getEncodeTable(encoding) {
    if (!encodeTableStd) {
      encodeTableStd = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("");
      encodeTableUrl = encodeTableStd.slice(0, -2).concat("-", "_");
    }
    return encoding == "url" ? (
      // biome-ignore lint/style/noNonNullAssertion: TS fails to narrow down
      encodeTableUrl
    ) : encodeTableStd;
  }
  function getDecodeTable() {
    if (!decodeTable) {
      decodeTable = [];
      const encodeTable = getEncodeTable("std");
      for (let i = 0; i < encodeTable.length; i++)
        decodeTable[encodeTable[i].charCodeAt(0)] = i;
      decodeTable["-".charCodeAt(0)] = encodeTable.indexOf("+");
      decodeTable["_".charCodeAt(0)] = encodeTable.indexOf("/");
    }
    return decodeTable;
  }
  var encodeTableStd, encodeTableUrl, decodeTable;
  var init_base64_encoding = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/wire/base64-encoding.js"() {
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/reflect/names.js
  function protoCamelCase(snakeCase) {
    let capNext = false;
    const b = [];
    for (let i = 0; i < snakeCase.length; i++) {
      let c = snakeCase.charAt(i);
      switch (c) {
        case "_":
          capNext = true;
          break;
        case "0":
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
        case "6":
        case "7":
        case "8":
        case "9":
          b.push(c);
          capNext = false;
          break;
        default:
          if (capNext) {
            capNext = false;
            c = c.toUpperCase();
          }
          b.push(c);
          break;
      }
    }
    return b.join("");
  }
  function safeObjectProperty(name) {
    return reservedObjectProperties.has(name) ? name + "$" : name;
  }
  var reservedObjectProperties;
  var init_names = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/reflect/names.js"() {
      reservedObjectProperties = /* @__PURE__ */ new Set([
        // names reserved by JavaScript
        "constructor",
        "toString",
        "toJSON",
        "valueOf"
      ]);
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/codegenv2/restore-json-names.js
  function restoreJsonNames(message) {
    for (const f of message.field) {
      if (!unsafeIsSetExplicit(f, "jsonName")) {
        f.jsonName = protoCamelCase(f.name);
      }
    }
    message.nestedType.forEach(restoreJsonNames);
  }
  var init_restore_json_names = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/codegenv2/restore-json-names.js"() {
      init_names();
      init_unsafe();
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/wire/text-format.js
  function parseTextFormatEnumValue(descEnum, value) {
    const enumValue = descEnum.values.find((v) => v.name === value);
    if (!enumValue) {
      throw new Error(`cannot parse ${descEnum} default value: ${value}`);
    }
    return enumValue.number;
  }
  function parseTextFormatScalarValue(type, value) {
    switch (type) {
      case ScalarType.STRING:
        return value;
      case ScalarType.BYTES: {
        const u = unescapeBytesDefaultValue(value);
        if (u === false) {
          throw new Error(`cannot parse ${ScalarType[type]} default value: ${value}`);
        }
        return u;
      }
      case ScalarType.INT64:
      case ScalarType.SFIXED64:
      case ScalarType.SINT64:
        return protoInt64.parse(value);
      case ScalarType.UINT64:
      case ScalarType.FIXED64:
        return protoInt64.uParse(value);
      case ScalarType.DOUBLE:
      case ScalarType.FLOAT:
        switch (value) {
          case "inf":
            return Number.POSITIVE_INFINITY;
          case "-inf":
            return Number.NEGATIVE_INFINITY;
          case "nan":
            return Number.NaN;
          default:
            return parseFloat(value);
        }
      case ScalarType.BOOL:
        return value === "true";
      case ScalarType.INT32:
      case ScalarType.UINT32:
      case ScalarType.SINT32:
      case ScalarType.FIXED32:
      case ScalarType.SFIXED32:
        return parseInt(value, 10);
    }
  }
  function unescapeBytesDefaultValue(str) {
    const b = [];
    const input = {
      tail: str,
      c: "",
      next() {
        if (this.tail.length == 0) {
          return false;
        }
        this.c = this.tail[0];
        this.tail = this.tail.substring(1);
        return true;
      },
      take(n) {
        if (this.tail.length >= n) {
          const r = this.tail.substring(0, n);
          this.tail = this.tail.substring(n);
          return r;
        }
        return false;
      }
    };
    while (input.next()) {
      switch (input.c) {
        case "\\":
          if (input.next()) {
            switch (input.c) {
              case "\\":
                b.push(input.c.charCodeAt(0));
                break;
              case "b":
                b.push(8);
                break;
              case "f":
                b.push(12);
                break;
              case "n":
                b.push(10);
                break;
              case "r":
                b.push(13);
                break;
              case "t":
                b.push(9);
                break;
              case "v":
                b.push(11);
                break;
              case "0":
              case "1":
              case "2":
              case "3":
              case "4":
              case "5":
              case "6":
              case "7": {
                const s = input.c;
                const t = input.take(2);
                if (t === false) {
                  return false;
                }
                const n = parseInt(s + t, 8);
                if (Number.isNaN(n)) {
                  return false;
                }
                b.push(n);
                break;
              }
              case "x": {
                const s = input.c;
                const t = input.take(2);
                if (t === false) {
                  return false;
                }
                const n = parseInt(s + t, 16);
                if (Number.isNaN(n)) {
                  return false;
                }
                b.push(n);
                break;
              }
              case "u": {
                const s = input.c;
                const t = input.take(4);
                if (t === false) {
                  return false;
                }
                const n = parseInt(s + t, 16);
                if (Number.isNaN(n)) {
                  return false;
                }
                const chunk = new Uint8Array(4);
                const view = new DataView(chunk.buffer);
                view.setInt32(0, n, true);
                b.push(chunk[0], chunk[1], chunk[2], chunk[3]);
                break;
              }
              case "U": {
                const s = input.c;
                const t = input.take(8);
                if (t === false) {
                  return false;
                }
                const tc = protoInt64.uEnc(s + t);
                const chunk = new Uint8Array(8);
                const view = new DataView(chunk.buffer);
                view.setInt32(0, tc.lo, true);
                view.setInt32(4, tc.hi, true);
                b.push(chunk[0], chunk[1], chunk[2], chunk[3], chunk[4], chunk[5], chunk[6], chunk[7]);
                break;
              }
            }
          }
          break;
        default:
          b.push(input.c.charCodeAt(0));
      }
    }
    return new Uint8Array(b);
  }
  var init_text_format = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/wire/text-format.js"() {
      init_descriptors();
      init_proto_int64();
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/reflect/nested-types.js
  function* nestedTypes(desc) {
    switch (desc.kind) {
      case "file":
        for (const message of desc.messages) {
          yield message;
          yield* __yieldStar(nestedTypes(message));
        }
        yield* __yieldStar(desc.enums);
        yield* __yieldStar(desc.services);
        yield* __yieldStar(desc.extensions);
        break;
      case "message":
        for (const message of desc.nestedMessages) {
          yield message;
          yield* __yieldStar(nestedTypes(message));
        }
        yield* __yieldStar(desc.nestedEnums);
        yield* __yieldStar(desc.nestedExtensions);
        break;
    }
  }
  var init_nested_types = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/reflect/nested-types.js"() {
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/registry.js
  function createFileRegistry(...args) {
    const registry = createBaseRegistry();
    if (!args.length) {
      return registry;
    }
    if ("$typeName" in args[0] && args[0].$typeName == "google.protobuf.FileDescriptorSet") {
      for (const file of args[0].file) {
        addFile(file, registry);
      }
      return registry;
    }
    if ("$typeName" in args[0]) {
      let recurseDeps = function(file) {
        const deps = [];
        for (const protoFileName of file.dependency) {
          if (registry.getFile(protoFileName) != void 0) {
            continue;
          }
          if (seen.has(protoFileName)) {
            continue;
          }
          const dep = resolve(protoFileName);
          if (!dep) {
            throw new Error(`Unable to resolve ${protoFileName}, imported by ${file.name}`);
          }
          if ("kind" in dep) {
            registry.addFile(dep, false, true);
          } else {
            seen.add(dep.name);
            deps.push(dep);
          }
        }
        return deps.concat(...deps.map(recurseDeps));
      };
      const input = args[0];
      const resolve = args[1];
      const seen = /* @__PURE__ */ new Set();
      for (const file of [input, ...recurseDeps(input)].reverse()) {
        addFile(file, registry);
      }
    } else {
      for (const fileReg of args) {
        for (const file of fileReg.files) {
          registry.addFile(file);
        }
      }
    }
    return registry;
  }
  function createBaseRegistry() {
    const types = /* @__PURE__ */ new Map();
    const extendees = /* @__PURE__ */ new Map();
    const files = /* @__PURE__ */ new Map();
    return {
      kind: "registry",
      types,
      extendees,
      [Symbol.iterator]() {
        return types.values();
      },
      get files() {
        return files.values();
      },
      addFile(file, skipTypes, withDeps) {
        files.set(file.proto.name, file);
        if (!skipTypes) {
          for (const type of nestedTypes(file)) {
            this.add(type);
          }
        }
        if (withDeps) {
          for (const f of file.dependencies) {
            this.addFile(f, skipTypes, withDeps);
          }
        }
      },
      add(desc) {
        if (desc.kind == "extension") {
          let numberToExt = extendees.get(desc.extendee.typeName);
          if (!numberToExt) {
            extendees.set(
              desc.extendee.typeName,
              // biome-ignore lint/suspicious/noAssignInExpressions: no
              numberToExt = /* @__PURE__ */ new Map()
            );
          }
          numberToExt.set(desc.number, desc);
        }
        types.set(desc.typeName, desc);
      },
      get(typeName) {
        return types.get(typeName);
      },
      getFile(fileName) {
        return files.get(fileName);
      },
      getMessage(typeName) {
        const t = types.get(typeName);
        return (t === null || t === void 0 ? void 0 : t.kind) == "message" ? t : void 0;
      },
      getEnum(typeName) {
        const t = types.get(typeName);
        return (t === null || t === void 0 ? void 0 : t.kind) == "enum" ? t : void 0;
      },
      getExtension(typeName) {
        const t = types.get(typeName);
        return (t === null || t === void 0 ? void 0 : t.kind) == "extension" ? t : void 0;
      },
      getExtensionFor(extendee, no) {
        var _a;
        return (_a = extendees.get(extendee.typeName)) === null || _a === void 0 ? void 0 : _a.get(no);
      },
      getService(typeName) {
        const t = types.get(typeName);
        return (t === null || t === void 0 ? void 0 : t.kind) == "service" ? t : void 0;
      }
    };
  }
  function addFile(proto, reg) {
    var _a, _b;
    const file = {
      kind: "file",
      proto,
      deprecated: (_b = (_a = proto.options) === null || _a === void 0 ? void 0 : _a.deprecated) !== null && _b !== void 0 ? _b : false,
      edition: getFileEdition(proto),
      name: proto.name.replace(/\.proto$/, ""),
      dependencies: findFileDependencies(proto, reg),
      enums: [],
      messages: [],
      extensions: [],
      services: [],
      toString() {
        return `file ${proto.name}`;
      }
    };
    const mapEntriesStore = /* @__PURE__ */ new Map();
    const mapEntries = {
      get(typeName) {
        return mapEntriesStore.get(typeName);
      },
      add(desc) {
        var _a2;
        assert(((_a2 = desc.proto.options) === null || _a2 === void 0 ? void 0 : _a2.mapEntry) === true);
        mapEntriesStore.set(desc.typeName, desc);
      }
    };
    for (const enumProto of proto.enumType) {
      addEnum(enumProto, file, void 0, reg);
    }
    for (const messageProto of proto.messageType) {
      addMessage(messageProto, file, void 0, reg, mapEntries);
    }
    for (const serviceProto of proto.service) {
      addService(serviceProto, file, reg);
    }
    addExtensions(file, reg);
    for (const mapEntry of mapEntriesStore.values()) {
      addFields(mapEntry, reg, mapEntries);
    }
    for (const message of file.messages) {
      addFields(message, reg, mapEntries);
      addExtensions(message, reg);
    }
    reg.addFile(file, true);
  }
  function addExtensions(desc, reg) {
    switch (desc.kind) {
      case "file":
        for (const proto of desc.proto.extension) {
          const ext = newField(proto, desc, reg);
          desc.extensions.push(ext);
          reg.add(ext);
        }
        break;
      case "message":
        for (const proto of desc.proto.extension) {
          const ext = newField(proto, desc, reg);
          desc.nestedExtensions.push(ext);
          reg.add(ext);
        }
        for (const message of desc.nestedMessages) {
          addExtensions(message, reg);
        }
        break;
    }
  }
  function addFields(message, reg, mapEntries) {
    const allOneofs = message.proto.oneofDecl.map((proto) => newOneof(proto, message));
    const oneofsSeen = /* @__PURE__ */ new Set();
    for (const proto of message.proto.field) {
      const oneof = findOneof(proto, allOneofs);
      const field = newField(proto, message, reg, oneof, mapEntries);
      message.fields.push(field);
      message.field[field.localName] = field;
      if (oneof === void 0) {
        message.members.push(field);
      } else {
        oneof.fields.push(field);
        if (!oneofsSeen.has(oneof)) {
          oneofsSeen.add(oneof);
          message.members.push(oneof);
        }
      }
    }
    for (const oneof of allOneofs.filter((o) => oneofsSeen.has(o))) {
      message.oneofs.push(oneof);
    }
    for (const child of message.nestedMessages) {
      addFields(child, reg, mapEntries);
    }
  }
  function addEnum(proto, file, parent, reg) {
    var _a, _b, _c, _d, _e;
    const sharedPrefix = findEnumSharedPrefix(proto.name, proto.value);
    const desc = {
      kind: "enum",
      proto,
      deprecated: (_b = (_a = proto.options) === null || _a === void 0 ? void 0 : _a.deprecated) !== null && _b !== void 0 ? _b : false,
      file,
      parent,
      open: true,
      name: proto.name,
      typeName: makeTypeName(proto, parent, file),
      value: {},
      values: [],
      sharedPrefix,
      toString() {
        return `enum ${this.typeName}`;
      }
    };
    desc.open = isEnumOpen(desc);
    reg.add(desc);
    for (const p of proto.value) {
      const name = p.name;
      desc.values.push(
        // biome-ignore lint/suspicious/noAssignInExpressions: no
        desc.value[p.number] = {
          kind: "enum_value",
          proto: p,
          deprecated: (_d = (_c = p.options) === null || _c === void 0 ? void 0 : _c.deprecated) !== null && _d !== void 0 ? _d : false,
          parent: desc,
          name,
          localName: safeObjectProperty(sharedPrefix == void 0 ? name : name.substring(sharedPrefix.length)),
          number: p.number,
          toString() {
            return `enum value ${desc.typeName}.${name}`;
          }
        }
      );
    }
    ((_e = parent === null || parent === void 0 ? void 0 : parent.nestedEnums) !== null && _e !== void 0 ? _e : file.enums).push(desc);
  }
  function addMessage(proto, file, parent, reg, mapEntries) {
    var _a, _b, _c, _d;
    const desc = {
      kind: "message",
      proto,
      deprecated: (_b = (_a = proto.options) === null || _a === void 0 ? void 0 : _a.deprecated) !== null && _b !== void 0 ? _b : false,
      file,
      parent,
      name: proto.name,
      typeName: makeTypeName(proto, parent, file),
      fields: [],
      field: {},
      oneofs: [],
      members: [],
      nestedEnums: [],
      nestedMessages: [],
      nestedExtensions: [],
      toString() {
        return `message ${this.typeName}`;
      }
    };
    if (((_c = proto.options) === null || _c === void 0 ? void 0 : _c.mapEntry) === true) {
      mapEntries.add(desc);
    } else {
      ((_d = parent === null || parent === void 0 ? void 0 : parent.nestedMessages) !== null && _d !== void 0 ? _d : file.messages).push(desc);
      reg.add(desc);
    }
    for (const enumProto of proto.enumType) {
      addEnum(enumProto, file, desc, reg);
    }
    for (const messageProto of proto.nestedType) {
      addMessage(messageProto, file, desc, reg, mapEntries);
    }
  }
  function addService(proto, file, reg) {
    var _a, _b;
    const desc = {
      kind: "service",
      proto,
      deprecated: (_b = (_a = proto.options) === null || _a === void 0 ? void 0 : _a.deprecated) !== null && _b !== void 0 ? _b : false,
      file,
      name: proto.name,
      typeName: makeTypeName(proto, void 0, file),
      methods: [],
      method: {},
      toString() {
        return `service ${this.typeName}`;
      }
    };
    file.services.push(desc);
    reg.add(desc);
    for (const methodProto of proto.method) {
      const method = newMethod(methodProto, desc, reg);
      desc.methods.push(method);
      desc.method[method.localName] = method;
    }
  }
  function newMethod(proto, parent, reg) {
    var _a, _b, _c, _d;
    let methodKind;
    if (proto.clientStreaming && proto.serverStreaming) {
      methodKind = "bidi_streaming";
    } else if (proto.clientStreaming) {
      methodKind = "client_streaming";
    } else if (proto.serverStreaming) {
      methodKind = "server_streaming";
    } else {
      methodKind = "unary";
    }
    const input = reg.getMessage(trimLeadingDot(proto.inputType));
    const output = reg.getMessage(trimLeadingDot(proto.outputType));
    assert(input, `invalid MethodDescriptorProto: input_type ${proto.inputType} not found`);
    assert(output, `invalid MethodDescriptorProto: output_type ${proto.inputType} not found`);
    const name = proto.name;
    return {
      kind: "rpc",
      proto,
      deprecated: (_b = (_a = proto.options) === null || _a === void 0 ? void 0 : _a.deprecated) !== null && _b !== void 0 ? _b : false,
      parent,
      name,
      localName: safeObjectProperty(name.length ? safeObjectProperty(name[0].toLowerCase() + name.substring(1)) : name),
      methodKind,
      input,
      output,
      idempotency: (_d = (_c = proto.options) === null || _c === void 0 ? void 0 : _c.idempotencyLevel) !== null && _d !== void 0 ? _d : IDEMPOTENCY_UNKNOWN,
      toString() {
        return `rpc ${parent.typeName}.${name}`;
      }
    };
  }
  function newOneof(proto, parent) {
    return {
      kind: "oneof",
      proto,
      deprecated: false,
      parent,
      fields: [],
      name: proto.name,
      localName: safeObjectProperty(protoCamelCase(proto.name)),
      toString() {
        return `oneof ${parent.typeName}.${this.name}`;
      }
    };
  }
  function newField(proto, parentOrFile, reg, oneof, mapEntries) {
    var _a, _b, _c;
    const isExtension = mapEntries === void 0;
    const field = {
      kind: "field",
      proto,
      deprecated: (_b = (_a = proto.options) === null || _a === void 0 ? void 0 : _a.deprecated) !== null && _b !== void 0 ? _b : false,
      name: proto.name,
      number: proto.number,
      scalar: void 0,
      message: void 0,
      enum: void 0,
      presence: getFieldPresence(proto, oneof, isExtension, parentOrFile),
      utf8Validation: isUtf8Validated(proto, parentOrFile),
      listKind: void 0,
      mapKind: void 0,
      mapKey: void 0,
      delimitedEncoding: void 0,
      packed: void 0,
      longAsString: false,
      getDefaultValue: void 0
    };
    if (isExtension) {
      const file = parentOrFile.kind == "file" ? parentOrFile : parentOrFile.file;
      const parent = parentOrFile.kind == "file" ? void 0 : parentOrFile;
      const typeName = makeTypeName(proto, parent, file);
      field.kind = "extension";
      field.file = file;
      field.parent = parent;
      field.oneof = void 0;
      field.typeName = typeName;
      field.jsonName = `[${typeName}]`;
      field.toString = () => `extension ${typeName}`;
      const extendee = reg.getMessage(trimLeadingDot(proto.extendee));
      assert(extendee, `invalid FieldDescriptorProto: extendee ${proto.extendee} not found`);
      field.extendee = extendee;
    } else {
      const parent = parentOrFile;
      assert(parent.kind == "message");
      field.parent = parent;
      field.oneof = oneof;
      field.localName = oneof ? protoCamelCase(proto.name) : safeObjectProperty(protoCamelCase(proto.name));
      field.jsonName = proto.jsonName;
      field.toString = () => `field ${parent.typeName}.${proto.name}`;
    }
    const label = proto.label;
    const type = proto.type;
    const jstype = (_c = proto.options) === null || _c === void 0 ? void 0 : _c.jstype;
    if (label === LABEL_REPEATED) {
      const mapEntry = type == TYPE_MESSAGE ? mapEntries === null || mapEntries === void 0 ? void 0 : mapEntries.get(trimLeadingDot(proto.typeName)) : void 0;
      if (mapEntry) {
        field.fieldKind = "map";
        const { key, value } = findMapEntryFields(mapEntry);
        field.mapKey = key.scalar;
        field.mapKind = value.fieldKind;
        field.message = value.message;
        field.delimitedEncoding = false;
        field.enum = value.enum;
        field.scalar = value.scalar;
        return field;
      }
      field.fieldKind = "list";
      switch (type) {
        case TYPE_MESSAGE:
        case TYPE_GROUP:
          field.listKind = "message";
          field.message = reg.getMessage(trimLeadingDot(proto.typeName));
          assert(field.message);
          field.delimitedEncoding = isDelimitedEncoding(proto, parentOrFile);
          break;
        case TYPE_ENUM:
          field.listKind = "enum";
          field.enum = reg.getEnum(trimLeadingDot(proto.typeName));
          assert(field.enum);
          break;
        default:
          field.listKind = "scalar";
          field.scalar = type;
          field.longAsString = jstype == JS_STRING;
          break;
      }
      field.packed = isPackedField(proto, parentOrFile);
      return field;
    }
    switch (type) {
      case TYPE_MESSAGE:
      case TYPE_GROUP:
        field.fieldKind = "message";
        field.message = reg.getMessage(trimLeadingDot(proto.typeName));
        assert(field.message, `invalid FieldDescriptorProto: type_name ${proto.typeName} not found`);
        field.delimitedEncoding = isDelimitedEncoding(proto, parentOrFile);
        field.getDefaultValue = () => void 0;
        break;
      case TYPE_ENUM: {
        const enumeration = reg.getEnum(trimLeadingDot(proto.typeName));
        assert(enumeration !== void 0, `invalid FieldDescriptorProto: type_name ${proto.typeName} not found`);
        field.fieldKind = "enum";
        field.enum = reg.getEnum(trimLeadingDot(proto.typeName));
        field.getDefaultValue = () => {
          return unsafeIsSetExplicit(proto, "defaultValue") ? parseTextFormatEnumValue(enumeration, proto.defaultValue) : void 0;
        };
        break;
      }
      default: {
        field.fieldKind = "scalar";
        field.scalar = type;
        field.longAsString = jstype == JS_STRING;
        field.getDefaultValue = () => {
          return unsafeIsSetExplicit(proto, "defaultValue") ? parseTextFormatScalarValue(type, proto.defaultValue) : void 0;
        };
        break;
      }
    }
    return field;
  }
  function getFileEdition(proto) {
    switch (proto.syntax) {
      case "":
      case "proto2":
        return EDITION_PROTO22;
      case "proto3":
        return EDITION_PROTO32;
      case "editions":
        if (proto.edition === EDITION_UNSTABLE) {
          return maximumEdition;
        }
        if (proto.edition in featureDefaults) {
          return proto.edition;
        }
        throw new Error(`${proto.name}: unsupported edition`);
      default:
        throw new Error(`${proto.name}: unsupported syntax "${proto.syntax}"`);
    }
  }
  function findFileDependencies(proto, reg) {
    return proto.dependency.map((wantName) => {
      const dep = reg.getFile(wantName);
      if (!dep) {
        throw new Error(`Cannot find ${wantName}, imported by ${proto.name}`);
      }
      return dep;
    });
  }
  function findEnumSharedPrefix(enumName, values) {
    const prefix = camelToSnakeCase(enumName) + "_";
    for (const value of values) {
      if (!value.name.toLowerCase().startsWith(prefix)) {
        return void 0;
      }
      const shortName = value.name.substring(prefix.length);
      if (shortName.length == 0) {
        return void 0;
      }
      if (/^\d/.test(shortName)) {
        return void 0;
      }
    }
    return prefix;
  }
  function camelToSnakeCase(camel) {
    return (camel.substring(0, 1) + camel.substring(1).replace(/[A-Z]/g, (c) => "_" + c)).toLowerCase();
  }
  function makeTypeName(proto, parent, file) {
    let typeName;
    if (parent) {
      typeName = `${parent.typeName}.${proto.name}`;
    } else if (file.proto.package.length > 0) {
      typeName = `${file.proto.package}.${proto.name}`;
    } else {
      typeName = `${proto.name}`;
    }
    return typeName;
  }
  function trimLeadingDot(typeName) {
    return typeName.startsWith(".") ? typeName.substring(1) : typeName;
  }
  function findOneof(proto, allOneofs) {
    if (!unsafeIsSetExplicit(proto, "oneofIndex")) {
      return void 0;
    }
    if (proto.proto3Optional) {
      return void 0;
    }
    const oneof = allOneofs[proto.oneofIndex];
    assert(oneof, `invalid FieldDescriptorProto: oneof #${proto.oneofIndex} for field #${proto.number} not found`);
    return oneof;
  }
  function getFieldPresence(proto, oneof, isExtension, parent) {
    if (proto.label == LABEL_REQUIRED) {
      return LEGACY_REQUIRED;
    }
    if (proto.label == LABEL_REPEATED) {
      return IMPLICIT3;
    }
    if (!!oneof || proto.proto3Optional) {
      return EXPLICIT;
    }
    if (isExtension) {
      return EXPLICIT;
    }
    const resolved = resolveFeature("fieldPresence", { proto, parent });
    if (resolved == IMPLICIT3 && (proto.type == TYPE_MESSAGE || proto.type == TYPE_GROUP)) {
      return EXPLICIT;
    }
    return resolved;
  }
  function isPackedField(proto, parent) {
    if (proto.label != LABEL_REPEATED) {
      return false;
    }
    switch (proto.type) {
      case TYPE_STRING:
      case TYPE_BYTES:
      case TYPE_GROUP:
      case TYPE_MESSAGE:
        return false;
    }
    const o = proto.options;
    if (o && unsafeIsSetExplicit(o, "packed")) {
      return o.packed;
    }
    return PACKED == resolveFeature("repeatedFieldEncoding", {
      proto,
      parent
    });
  }
  function findMapEntryFields(mapEntry) {
    const key = mapEntry.fields.find((f) => f.number === 1);
    const value = mapEntry.fields.find((f) => f.number === 2);
    assert(key && key.fieldKind == "scalar" && key.scalar != ScalarType.BYTES && key.scalar != ScalarType.FLOAT && key.scalar != ScalarType.DOUBLE && value && value.fieldKind != "list" && value.fieldKind != "map");
    return { key, value };
  }
  function isEnumOpen(desc) {
    var _a;
    return OPEN == resolveFeature("enumType", {
      proto: desc.proto,
      parent: (_a = desc.parent) !== null && _a !== void 0 ? _a : desc.file
    });
  }
  function isDelimitedEncoding(proto, parent) {
    if (proto.type == TYPE_GROUP) {
      return true;
    }
    return DELIMITED == resolveFeature("messageEncoding", {
      proto,
      parent
    });
  }
  function isUtf8Validated(proto, parent) {
    return VERIFY == resolveFeature("utf8Validation", {
      proto,
      parent
    });
  }
  function resolveFeature(name, ref) {
    var _a, _b;
    const featureSet = (_a = ref.proto.options) === null || _a === void 0 ? void 0 : _a.features;
    if (featureSet) {
      const val = featureSet[name];
      if (val != 0) {
        return val;
      }
    }
    if ("kind" in ref) {
      if (ref.kind == "message") {
        return resolveFeature(name, (_b = ref.parent) !== null && _b !== void 0 ? _b : ref.file);
      }
      const editionDefaults = featureDefaults[ref.edition];
      if (!editionDefaults) {
        throw new Error(`feature default for edition ${ref.edition} not found`);
      }
      return editionDefaults[name];
    }
    return resolveFeature(name, ref.parent);
  }
  function assert(condition, msg) {
    if (!condition) {
      throw new Error(msg);
    }
  }
  var EDITION_PROTO22, EDITION_PROTO32, EDITION_UNSTABLE, TYPE_STRING, TYPE_GROUP, TYPE_MESSAGE, TYPE_BYTES, TYPE_ENUM, LABEL_REPEATED, LABEL_REQUIRED, JS_STRING, IDEMPOTENCY_UNKNOWN, EXPLICIT, IMPLICIT3, LEGACY_REQUIRED, PACKED, DELIMITED, OPEN, VERIFY, maximumEdition, featureDefaults;
  var init_registry = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/registry.js"() {
      init_descriptors();
      init_text_format();
      init_nested_types();
      init_unsafe();
      init_names();
      EDITION_PROTO22 = 998;
      EDITION_PROTO32 = 999;
      EDITION_UNSTABLE = 9999;
      TYPE_STRING = 9;
      TYPE_GROUP = 10;
      TYPE_MESSAGE = 11;
      TYPE_BYTES = 12;
      TYPE_ENUM = 14;
      LABEL_REPEATED = 3;
      LABEL_REQUIRED = 2;
      JS_STRING = 1;
      IDEMPOTENCY_UNKNOWN = 0;
      EXPLICIT = 1;
      IMPLICIT3 = 2;
      LEGACY_REQUIRED = 3;
      PACKED = 1;
      DELIMITED = 2;
      OPEN = 1;
      VERIFY = 2;
      maximumEdition = 1001;
      featureDefaults = {
        // EDITION_PROTO2
        998: {
          fieldPresence: 1,
          // EXPLICIT,
          enumType: 2,
          // CLOSED,
          repeatedFieldEncoding: 2,
          // EXPANDED,
          utf8Validation: 3,
          // NONE,
          messageEncoding: 1,
          // LENGTH_PREFIXED,
          jsonFormat: 2,
          // LEGACY_BEST_EFFORT,
          enforceNamingStyle: 2,
          // STYLE_LEGACY,
          defaultSymbolVisibility: 1
          // EXPORT_ALL,
        },
        // EDITION_PROTO3
        999: {
          fieldPresence: 2,
          // IMPLICIT,
          enumType: 1,
          // OPEN,
          repeatedFieldEncoding: 1,
          // PACKED,
          utf8Validation: 2,
          // VERIFY,
          messageEncoding: 1,
          // LENGTH_PREFIXED,
          jsonFormat: 1,
          // ALLOW,
          enforceNamingStyle: 2,
          // STYLE_LEGACY,
          defaultSymbolVisibility: 1
          // EXPORT_ALL,
        },
        // EDITION_2023
        1e3: {
          fieldPresence: 1,
          // EXPLICIT,
          enumType: 1,
          // OPEN,
          repeatedFieldEncoding: 1,
          // PACKED,
          utf8Validation: 2,
          // VERIFY,
          messageEncoding: 1,
          // LENGTH_PREFIXED,
          jsonFormat: 1,
          // ALLOW,
          enforceNamingStyle: 2,
          // STYLE_LEGACY,
          defaultSymbolVisibility: 1
          // EXPORT_ALL,
        },
        // EDITION_2024
        1001: {
          fieldPresence: 1,
          // EXPLICIT,
          enumType: 1,
          // OPEN,
          repeatedFieldEncoding: 1,
          // PACKED,
          utf8Validation: 2,
          // VERIFY,
          messageEncoding: 1,
          // LENGTH_PREFIXED,
          jsonFormat: 1,
          // ALLOW,
          enforceNamingStyle: 1,
          // STYLE2024,
          defaultSymbolVisibility: 2
          // EXPORT_TOP_LEVEL,
        }
      };
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/codegenv2/boot.js
  function boot(boot2) {
    const root = bootFileDescriptorProto(boot2);
    root.messageType.forEach(restoreJsonNames);
    const reg = createFileRegistry(root, () => void 0);
    return reg.getFile(root.name);
  }
  function bootFileDescriptorProto(init) {
    const proto = /* @__PURE__ */ Object.create({
      syntax: "",
      edition: 0
    });
    return Object.assign(proto, Object.assign(Object.assign({ $typeName: "google.protobuf.FileDescriptorProto", dependency: [], publicDependency: [], weakDependency: [], optionDependency: [], service: [], extension: [] }, init), { messageType: init.messageType.map(bootDescriptorProto), enumType: init.enumType.map(bootEnumDescriptorProto) }));
  }
  function bootDescriptorProto(init) {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    const proto = /* @__PURE__ */ Object.create({
      visibility: 0
    });
    return Object.assign(proto, {
      $typeName: "google.protobuf.DescriptorProto",
      name: init.name,
      field: (_b = (_a = init.field) === null || _a === void 0 ? void 0 : _a.map(bootFieldDescriptorProto)) !== null && _b !== void 0 ? _b : [],
      extension: [],
      nestedType: (_d = (_c = init.nestedType) === null || _c === void 0 ? void 0 : _c.map(bootDescriptorProto)) !== null && _d !== void 0 ? _d : [],
      enumType: (_f = (_e = init.enumType) === null || _e === void 0 ? void 0 : _e.map(bootEnumDescriptorProto)) !== null && _f !== void 0 ? _f : [],
      extensionRange: (_h = (_g = init.extensionRange) === null || _g === void 0 ? void 0 : _g.map((e) => Object.assign({ $typeName: "google.protobuf.DescriptorProto.ExtensionRange" }, e))) !== null && _h !== void 0 ? _h : [],
      oneofDecl: [],
      reservedRange: [],
      reservedName: []
    });
  }
  function bootFieldDescriptorProto(init) {
    const proto = /* @__PURE__ */ Object.create({
      label: 1,
      typeName: "",
      extendee: "",
      defaultValue: "",
      oneofIndex: 0,
      jsonName: "",
      proto3Optional: false
    });
    return Object.assign(proto, Object.assign(Object.assign({ $typeName: "google.protobuf.FieldDescriptorProto" }, init), { options: init.options ? bootFieldOptions(init.options) : void 0 }));
  }
  function bootFieldOptions(init) {
    var _a, _b, _c;
    const proto = /* @__PURE__ */ Object.create({
      ctype: 0,
      packed: false,
      jstype: 0,
      lazy: false,
      unverifiedLazy: false,
      deprecated: false,
      weak: false,
      debugRedact: false,
      retention: 0
    });
    return Object.assign(proto, Object.assign(Object.assign({ $typeName: "google.protobuf.FieldOptions" }, init), { targets: (_a = init.targets) !== null && _a !== void 0 ? _a : [], editionDefaults: (_c = (_b = init.editionDefaults) === null || _b === void 0 ? void 0 : _b.map((e) => Object.assign({ $typeName: "google.protobuf.FieldOptions.EditionDefault" }, e))) !== null && _c !== void 0 ? _c : [], uninterpretedOption: [] }));
  }
  function bootEnumDescriptorProto(init) {
    const proto = /* @__PURE__ */ Object.create({
      visibility: 0
    });
    return Object.assign(proto, {
      $typeName: "google.protobuf.EnumDescriptorProto",
      name: init.name,
      reservedName: [],
      reservedRange: [],
      value: init.value.map((e) => Object.assign({ $typeName: "google.protobuf.EnumValueDescriptorProto" }, e))
    });
  }
  var init_boot = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/codegenv2/boot.js"() {
      init_restore_json_names();
      init_registry();
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/codegenv2/message.js
  function messageDesc(file, path, ...paths) {
    return paths.reduce((acc, cur) => acc.nestedMessages[cur], file.messages[path]);
  }
  var init_message = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/codegenv2/message.js"() {
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/codegenv2/enum.js
  var init_enum = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/codegenv2/enum.js"() {
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/wkt/gen/google/protobuf/descriptor_pb.js
  var file_google_protobuf_descriptor, FileDescriptorProtoSchema, ExtensionRangeOptions_VerificationState, FieldDescriptorProto_Type, FieldDescriptorProto_Label, FileOptions_OptimizeMode, FieldOptions_CType, FieldOptions_JSType, FieldOptions_OptionRetention, FieldOptions_OptionTargetType, MethodOptions_IdempotencyLevel, FeatureSet_VisibilityFeature_DefaultSymbolVisibility, FeatureSet_FieldPresence, FeatureSet_EnumType, FeatureSet_RepeatedFieldEncoding, FeatureSet_Utf8Validation, FeatureSet_MessageEncoding, FeatureSet_JsonFormat, FeatureSet_EnforceNamingStyle, GeneratedCodeInfo_Annotation_Semantic, Edition, SymbolVisibility;
  var init_descriptor_pb = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/wkt/gen/google/protobuf/descriptor_pb.js"() {
      init_boot();
      init_message();
      file_google_protobuf_descriptor = /* @__PURE__ */ boot({ "name": "google/protobuf/descriptor.proto", "package": "google.protobuf", "messageType": [{ "name": "FileDescriptorSet", "field": [{ "name": "file", "number": 1, "type": 11, "label": 3, "typeName": ".google.protobuf.FileDescriptorProto" }], "extensionRange": [{ "start": 536e6, "end": 536000001 }] }, { "name": "FileDescriptorProto", "field": [{ "name": "name", "number": 1, "type": 9, "label": 1 }, { "name": "package", "number": 2, "type": 9, "label": 1 }, { "name": "dependency", "number": 3, "type": 9, "label": 3 }, { "name": "public_dependency", "number": 10, "type": 5, "label": 3 }, { "name": "weak_dependency", "number": 11, "type": 5, "label": 3 }, { "name": "option_dependency", "number": 15, "type": 9, "label": 3 }, { "name": "message_type", "number": 4, "type": 11, "label": 3, "typeName": ".google.protobuf.DescriptorProto" }, { "name": "enum_type", "number": 5, "type": 11, "label": 3, "typeName": ".google.protobuf.EnumDescriptorProto" }, { "name": "service", "number": 6, "type": 11, "label": 3, "typeName": ".google.protobuf.ServiceDescriptorProto" }, { "name": "extension", "number": 7, "type": 11, "label": 3, "typeName": ".google.protobuf.FieldDescriptorProto" }, { "name": "options", "number": 8, "type": 11, "label": 1, "typeName": ".google.protobuf.FileOptions" }, { "name": "source_code_info", "number": 9, "type": 11, "label": 1, "typeName": ".google.protobuf.SourceCodeInfo" }, { "name": "syntax", "number": 12, "type": 9, "label": 1 }, { "name": "edition", "number": 14, "type": 14, "label": 1, "typeName": ".google.protobuf.Edition" }] }, { "name": "DescriptorProto", "field": [{ "name": "name", "number": 1, "type": 9, "label": 1 }, { "name": "field", "number": 2, "type": 11, "label": 3, "typeName": ".google.protobuf.FieldDescriptorProto" }, { "name": "extension", "number": 6, "type": 11, "label": 3, "typeName": ".google.protobuf.FieldDescriptorProto" }, { "name": "nested_type", "number": 3, "type": 11, "label": 3, "typeName": ".google.protobuf.DescriptorProto" }, { "name": "enum_type", "number": 4, "type": 11, "label": 3, "typeName": ".google.protobuf.EnumDescriptorProto" }, { "name": "extension_range", "number": 5, "type": 11, "label": 3, "typeName": ".google.protobuf.DescriptorProto.ExtensionRange" }, { "name": "oneof_decl", "number": 8, "type": 11, "label": 3, "typeName": ".google.protobuf.OneofDescriptorProto" }, { "name": "options", "number": 7, "type": 11, "label": 1, "typeName": ".google.protobuf.MessageOptions" }, { "name": "reserved_range", "number": 9, "type": 11, "label": 3, "typeName": ".google.protobuf.DescriptorProto.ReservedRange" }, { "name": "reserved_name", "number": 10, "type": 9, "label": 3 }, { "name": "visibility", "number": 11, "type": 14, "label": 1, "typeName": ".google.protobuf.SymbolVisibility" }], "nestedType": [{ "name": "ExtensionRange", "field": [{ "name": "start", "number": 1, "type": 5, "label": 1 }, { "name": "end", "number": 2, "type": 5, "label": 1 }, { "name": "options", "number": 3, "type": 11, "label": 1, "typeName": ".google.protobuf.ExtensionRangeOptions" }] }, { "name": "ReservedRange", "field": [{ "name": "start", "number": 1, "type": 5, "label": 1 }, { "name": "end", "number": 2, "type": 5, "label": 1 }] }] }, { "name": "ExtensionRangeOptions", "field": [{ "name": "uninterpreted_option", "number": 999, "type": 11, "label": 3, "typeName": ".google.protobuf.UninterpretedOption" }, { "name": "declaration", "number": 2, "type": 11, "label": 3, "typeName": ".google.protobuf.ExtensionRangeOptions.Declaration", "options": { "retention": 2 } }, { "name": "features", "number": 50, "type": 11, "label": 1, "typeName": ".google.protobuf.FeatureSet" }, { "name": "verification", "number": 3, "type": 14, "label": 1, "typeName": ".google.protobuf.ExtensionRangeOptions.VerificationState", "defaultValue": "UNVERIFIED", "options": { "retention": 2 } }], "nestedType": [{ "name": "Declaration", "field": [{ "name": "number", "number": 1, "type": 5, "label": 1 }, { "name": "full_name", "number": 2, "type": 9, "label": 1 }, { "name": "type", "number": 3, "type": 9, "label": 1 }, { "name": "reserved", "number": 5, "type": 8, "label": 1 }, { "name": "repeated", "number": 6, "type": 8, "label": 1 }] }], "enumType": [{ "name": "VerificationState", "value": [{ "name": "DECLARATION", "number": 0 }, { "name": "UNVERIFIED", "number": 1 }] }], "extensionRange": [{ "start": 1e3, "end": 536870912 }] }, { "name": "FieldDescriptorProto", "field": [{ "name": "name", "number": 1, "type": 9, "label": 1 }, { "name": "number", "number": 3, "type": 5, "label": 1 }, { "name": "label", "number": 4, "type": 14, "label": 1, "typeName": ".google.protobuf.FieldDescriptorProto.Label" }, { "name": "type", "number": 5, "type": 14, "label": 1, "typeName": ".google.protobuf.FieldDescriptorProto.Type" }, { "name": "type_name", "number": 6, "type": 9, "label": 1 }, { "name": "extendee", "number": 2, "type": 9, "label": 1 }, { "name": "default_value", "number": 7, "type": 9, "label": 1 }, { "name": "oneof_index", "number": 9, "type": 5, "label": 1 }, { "name": "json_name", "number": 10, "type": 9, "label": 1 }, { "name": "options", "number": 8, "type": 11, "label": 1, "typeName": ".google.protobuf.FieldOptions" }, { "name": "proto3_optional", "number": 17, "type": 8, "label": 1 }], "enumType": [{ "name": "Type", "value": [{ "name": "TYPE_DOUBLE", "number": 1 }, { "name": "TYPE_FLOAT", "number": 2 }, { "name": "TYPE_INT64", "number": 3 }, { "name": "TYPE_UINT64", "number": 4 }, { "name": "TYPE_INT32", "number": 5 }, { "name": "TYPE_FIXED64", "number": 6 }, { "name": "TYPE_FIXED32", "number": 7 }, { "name": "TYPE_BOOL", "number": 8 }, { "name": "TYPE_STRING", "number": 9 }, { "name": "TYPE_GROUP", "number": 10 }, { "name": "TYPE_MESSAGE", "number": 11 }, { "name": "TYPE_BYTES", "number": 12 }, { "name": "TYPE_UINT32", "number": 13 }, { "name": "TYPE_ENUM", "number": 14 }, { "name": "TYPE_SFIXED32", "number": 15 }, { "name": "TYPE_SFIXED64", "number": 16 }, { "name": "TYPE_SINT32", "number": 17 }, { "name": "TYPE_SINT64", "number": 18 }] }, { "name": "Label", "value": [{ "name": "LABEL_OPTIONAL", "number": 1 }, { "name": "LABEL_REPEATED", "number": 3 }, { "name": "LABEL_REQUIRED", "number": 2 }] }] }, { "name": "OneofDescriptorProto", "field": [{ "name": "name", "number": 1, "type": 9, "label": 1 }, { "name": "options", "number": 2, "type": 11, "label": 1, "typeName": ".google.protobuf.OneofOptions" }] }, { "name": "EnumDescriptorProto", "field": [{ "name": "name", "number": 1, "type": 9, "label": 1 }, { "name": "value", "number": 2, "type": 11, "label": 3, "typeName": ".google.protobuf.EnumValueDescriptorProto" }, { "name": "options", "number": 3, "type": 11, "label": 1, "typeName": ".google.protobuf.EnumOptions" }, { "name": "reserved_range", "number": 4, "type": 11, "label": 3, "typeName": ".google.protobuf.EnumDescriptorProto.EnumReservedRange" }, { "name": "reserved_name", "number": 5, "type": 9, "label": 3 }, { "name": "visibility", "number": 6, "type": 14, "label": 1, "typeName": ".google.protobuf.SymbolVisibility" }], "nestedType": [{ "name": "EnumReservedRange", "field": [{ "name": "start", "number": 1, "type": 5, "label": 1 }, { "name": "end", "number": 2, "type": 5, "label": 1 }] }] }, { "name": "EnumValueDescriptorProto", "field": [{ "name": "name", "number": 1, "type": 9, "label": 1 }, { "name": "number", "number": 2, "type": 5, "label": 1 }, { "name": "options", "number": 3, "type": 11, "label": 1, "typeName": ".google.protobuf.EnumValueOptions" }] }, { "name": "ServiceDescriptorProto", "field": [{ "name": "name", "number": 1, "type": 9, "label": 1 }, { "name": "method", "number": 2, "type": 11, "label": 3, "typeName": ".google.protobuf.MethodDescriptorProto" }, { "name": "options", "number": 3, "type": 11, "label": 1, "typeName": ".google.protobuf.ServiceOptions" }] }, { "name": "MethodDescriptorProto", "field": [{ "name": "name", "number": 1, "type": 9, "label": 1 }, { "name": "input_type", "number": 2, "type": 9, "label": 1 }, { "name": "output_type", "number": 3, "type": 9, "label": 1 }, { "name": "options", "number": 4, "type": 11, "label": 1, "typeName": ".google.protobuf.MethodOptions" }, { "name": "client_streaming", "number": 5, "type": 8, "label": 1, "defaultValue": "false" }, { "name": "server_streaming", "number": 6, "type": 8, "label": 1, "defaultValue": "false" }] }, { "name": "FileOptions", "field": [{ "name": "java_package", "number": 1, "type": 9, "label": 1 }, { "name": "java_outer_classname", "number": 8, "type": 9, "label": 1 }, { "name": "java_multiple_files", "number": 10, "type": 8, "label": 1, "defaultValue": "false", "options": {} }, { "name": "java_generate_equals_and_hash", "number": 20, "type": 8, "label": 1, "options": { "deprecated": true } }, { "name": "java_string_check_utf8", "number": 27, "type": 8, "label": 1, "defaultValue": "false" }, { "name": "optimize_for", "number": 9, "type": 14, "label": 1, "typeName": ".google.protobuf.FileOptions.OptimizeMode", "defaultValue": "SPEED" }, { "name": "go_package", "number": 11, "type": 9, "label": 1 }, { "name": "cc_generic_services", "number": 16, "type": 8, "label": 1, "defaultValue": "false" }, { "name": "java_generic_services", "number": 17, "type": 8, "label": 1, "defaultValue": "false" }, { "name": "py_generic_services", "number": 18, "type": 8, "label": 1, "defaultValue": "false" }, { "name": "deprecated", "number": 23, "type": 8, "label": 1, "defaultValue": "false" }, { "name": "cc_enable_arenas", "number": 31, "type": 8, "label": 1, "defaultValue": "true" }, { "name": "objc_class_prefix", "number": 36, "type": 9, "label": 1 }, { "name": "csharp_namespace", "number": 37, "type": 9, "label": 1 }, { "name": "swift_prefix", "number": 39, "type": 9, "label": 1 }, { "name": "php_class_prefix", "number": 40, "type": 9, "label": 1 }, { "name": "php_namespace", "number": 41, "type": 9, "label": 1 }, { "name": "php_metadata_namespace", "number": 44, "type": 9, "label": 1 }, { "name": "ruby_package", "number": 45, "type": 9, "label": 1 }, { "name": "features", "number": 50, "type": 11, "label": 1, "typeName": ".google.protobuf.FeatureSet" }, { "name": "uninterpreted_option", "number": 999, "type": 11, "label": 3, "typeName": ".google.protobuf.UninterpretedOption" }], "enumType": [{ "name": "OptimizeMode", "value": [{ "name": "SPEED", "number": 1 }, { "name": "CODE_SIZE", "number": 2 }, { "name": "LITE_RUNTIME", "number": 3 }] }], "extensionRange": [{ "start": 1e3, "end": 536870912 }] }, { "name": "MessageOptions", "field": [{ "name": "message_set_wire_format", "number": 1, "type": 8, "label": 1, "defaultValue": "false" }, { "name": "no_standard_descriptor_accessor", "number": 2, "type": 8, "label": 1, "defaultValue": "false" }, { "name": "deprecated", "number": 3, "type": 8, "label": 1, "defaultValue": "false" }, { "name": "map_entry", "number": 7, "type": 8, "label": 1 }, { "name": "deprecated_legacy_json_field_conflicts", "number": 11, "type": 8, "label": 1, "options": { "deprecated": true } }, { "name": "features", "number": 12, "type": 11, "label": 1, "typeName": ".google.protobuf.FeatureSet" }, { "name": "uninterpreted_option", "number": 999, "type": 11, "label": 3, "typeName": ".google.protobuf.UninterpretedOption" }], "extensionRange": [{ "start": 1e3, "end": 536870912 }] }, { "name": "FieldOptions", "field": [{ "name": "ctype", "number": 1, "type": 14, "label": 1, "typeName": ".google.protobuf.FieldOptions.CType", "defaultValue": "STRING" }, { "name": "packed", "number": 2, "type": 8, "label": 1 }, { "name": "jstype", "number": 6, "type": 14, "label": 1, "typeName": ".google.protobuf.FieldOptions.JSType", "defaultValue": "JS_NORMAL" }, { "name": "lazy", "number": 5, "type": 8, "label": 1, "defaultValue": "false" }, { "name": "unverified_lazy", "number": 15, "type": 8, "label": 1, "defaultValue": "false" }, { "name": "deprecated", "number": 3, "type": 8, "label": 1, "defaultValue": "false" }, { "name": "weak", "number": 10, "type": 8, "label": 1, "defaultValue": "false", "options": { "deprecated": true } }, { "name": "debug_redact", "number": 16, "type": 8, "label": 1, "defaultValue": "false" }, { "name": "retention", "number": 17, "type": 14, "label": 1, "typeName": ".google.protobuf.FieldOptions.OptionRetention" }, { "name": "targets", "number": 19, "type": 14, "label": 3, "typeName": ".google.protobuf.FieldOptions.OptionTargetType" }, { "name": "edition_defaults", "number": 20, "type": 11, "label": 3, "typeName": ".google.protobuf.FieldOptions.EditionDefault" }, { "name": "features", "number": 21, "type": 11, "label": 1, "typeName": ".google.protobuf.FeatureSet" }, { "name": "feature_support", "number": 22, "type": 11, "label": 1, "typeName": ".google.protobuf.FieldOptions.FeatureSupport" }, { "name": "uninterpreted_option", "number": 999, "type": 11, "label": 3, "typeName": ".google.protobuf.UninterpretedOption" }], "nestedType": [{ "name": "EditionDefault", "field": [{ "name": "edition", "number": 3, "type": 14, "label": 1, "typeName": ".google.protobuf.Edition" }, { "name": "value", "number": 2, "type": 9, "label": 1 }] }, { "name": "FeatureSupport", "field": [{ "name": "edition_introduced", "number": 1, "type": 14, "label": 1, "typeName": ".google.protobuf.Edition" }, { "name": "edition_deprecated", "number": 2, "type": 14, "label": 1, "typeName": ".google.protobuf.Edition" }, { "name": "deprecation_warning", "number": 3, "type": 9, "label": 1 }, { "name": "edition_removed", "number": 4, "type": 14, "label": 1, "typeName": ".google.protobuf.Edition" }, { "name": "removal_error", "number": 5, "type": 9, "label": 1 }] }], "enumType": [{ "name": "CType", "value": [{ "name": "STRING", "number": 0 }, { "name": "CORD", "number": 1 }, { "name": "STRING_PIECE", "number": 2 }] }, { "name": "JSType", "value": [{ "name": "JS_NORMAL", "number": 0 }, { "name": "JS_STRING", "number": 1 }, { "name": "JS_NUMBER", "number": 2 }] }, { "name": "OptionRetention", "value": [{ "name": "RETENTION_UNKNOWN", "number": 0 }, { "name": "RETENTION_RUNTIME", "number": 1 }, { "name": "RETENTION_SOURCE", "number": 2 }] }, { "name": "OptionTargetType", "value": [{ "name": "TARGET_TYPE_UNKNOWN", "number": 0 }, { "name": "TARGET_TYPE_FILE", "number": 1 }, { "name": "TARGET_TYPE_EXTENSION_RANGE", "number": 2 }, { "name": "TARGET_TYPE_MESSAGE", "number": 3 }, { "name": "TARGET_TYPE_FIELD", "number": 4 }, { "name": "TARGET_TYPE_ONEOF", "number": 5 }, { "name": "TARGET_TYPE_ENUM", "number": 6 }, { "name": "TARGET_TYPE_ENUM_ENTRY", "number": 7 }, { "name": "TARGET_TYPE_SERVICE", "number": 8 }, { "name": "TARGET_TYPE_METHOD", "number": 9 }] }], "extensionRange": [{ "start": 1e3, "end": 536870912 }] }, { "name": "OneofOptions", "field": [{ "name": "features", "number": 1, "type": 11, "label": 1, "typeName": ".google.protobuf.FeatureSet" }, { "name": "uninterpreted_option", "number": 999, "type": 11, "label": 3, "typeName": ".google.protobuf.UninterpretedOption" }], "extensionRange": [{ "start": 1e3, "end": 536870912 }] }, { "name": "EnumOptions", "field": [{ "name": "allow_alias", "number": 2, "type": 8, "label": 1 }, { "name": "deprecated", "number": 3, "type": 8, "label": 1, "defaultValue": "false" }, { "name": "deprecated_legacy_json_field_conflicts", "number": 6, "type": 8, "label": 1, "options": { "deprecated": true } }, { "name": "features", "number": 7, "type": 11, "label": 1, "typeName": ".google.protobuf.FeatureSet" }, { "name": "uninterpreted_option", "number": 999, "type": 11, "label": 3, "typeName": ".google.protobuf.UninterpretedOption" }], "extensionRange": [{ "start": 1e3, "end": 536870912 }] }, { "name": "EnumValueOptions", "field": [{ "name": "deprecated", "number": 1, "type": 8, "label": 1, "defaultValue": "false" }, { "name": "features", "number": 2, "type": 11, "label": 1, "typeName": ".google.protobuf.FeatureSet" }, { "name": "debug_redact", "number": 3, "type": 8, "label": 1, "defaultValue": "false" }, { "name": "feature_support", "number": 4, "type": 11, "label": 1, "typeName": ".google.protobuf.FieldOptions.FeatureSupport" }, { "name": "uninterpreted_option", "number": 999, "type": 11, "label": 3, "typeName": ".google.protobuf.UninterpretedOption" }], "extensionRange": [{ "start": 1e3, "end": 536870912 }] }, { "name": "ServiceOptions", "field": [{ "name": "features", "number": 34, "type": 11, "label": 1, "typeName": ".google.protobuf.FeatureSet" }, { "name": "deprecated", "number": 33, "type": 8, "label": 1, "defaultValue": "false" }, { "name": "uninterpreted_option", "number": 999, "type": 11, "label": 3, "typeName": ".google.protobuf.UninterpretedOption" }], "extensionRange": [{ "start": 1e3, "end": 536870912 }] }, { "name": "MethodOptions", "field": [{ "name": "deprecated", "number": 33, "type": 8, "label": 1, "defaultValue": "false" }, { "name": "idempotency_level", "number": 34, "type": 14, "label": 1, "typeName": ".google.protobuf.MethodOptions.IdempotencyLevel", "defaultValue": "IDEMPOTENCY_UNKNOWN" }, { "name": "features", "number": 35, "type": 11, "label": 1, "typeName": ".google.protobuf.FeatureSet" }, { "name": "uninterpreted_option", "number": 999, "type": 11, "label": 3, "typeName": ".google.protobuf.UninterpretedOption" }], "enumType": [{ "name": "IdempotencyLevel", "value": [{ "name": "IDEMPOTENCY_UNKNOWN", "number": 0 }, { "name": "NO_SIDE_EFFECTS", "number": 1 }, { "name": "IDEMPOTENT", "number": 2 }] }], "extensionRange": [{ "start": 1e3, "end": 536870912 }] }, { "name": "UninterpretedOption", "field": [{ "name": "name", "number": 2, "type": 11, "label": 3, "typeName": ".google.protobuf.UninterpretedOption.NamePart" }, { "name": "identifier_value", "number": 3, "type": 9, "label": 1 }, { "name": "positive_int_value", "number": 4, "type": 4, "label": 1 }, { "name": "negative_int_value", "number": 5, "type": 3, "label": 1 }, { "name": "double_value", "number": 6, "type": 1, "label": 1 }, { "name": "string_value", "number": 7, "type": 12, "label": 1 }, { "name": "aggregate_value", "number": 8, "type": 9, "label": 1 }], "nestedType": [{ "name": "NamePart", "field": [{ "name": "name_part", "number": 1, "type": 9, "label": 2 }, { "name": "is_extension", "number": 2, "type": 8, "label": 2 }] }] }, { "name": "FeatureSet", "field": [{ "name": "field_presence", "number": 1, "type": 14, "label": 1, "typeName": ".google.protobuf.FeatureSet.FieldPresence", "options": { "retention": 1, "targets": [4, 1], "editionDefaults": [{ "value": "EXPLICIT", "edition": 900 }, { "value": "IMPLICIT", "edition": 999 }, { "value": "EXPLICIT", "edition": 1e3 }] } }, { "name": "enum_type", "number": 2, "type": 14, "label": 1, "typeName": ".google.protobuf.FeatureSet.EnumType", "options": { "retention": 1, "targets": [6, 1], "editionDefaults": [{ "value": "CLOSED", "edition": 900 }, { "value": "OPEN", "edition": 999 }] } }, { "name": "repeated_field_encoding", "number": 3, "type": 14, "label": 1, "typeName": ".google.protobuf.FeatureSet.RepeatedFieldEncoding", "options": { "retention": 1, "targets": [4, 1], "editionDefaults": [{ "value": "EXPANDED", "edition": 900 }, { "value": "PACKED", "edition": 999 }] } }, { "name": "utf8_validation", "number": 4, "type": 14, "label": 1, "typeName": ".google.protobuf.FeatureSet.Utf8Validation", "options": { "retention": 1, "targets": [4, 1], "editionDefaults": [{ "value": "NONE", "edition": 900 }, { "value": "VERIFY", "edition": 999 }] } }, { "name": "message_encoding", "number": 5, "type": 14, "label": 1, "typeName": ".google.protobuf.FeatureSet.MessageEncoding", "options": { "retention": 1, "targets": [4, 1], "editionDefaults": [{ "value": "LENGTH_PREFIXED", "edition": 900 }] } }, { "name": "json_format", "number": 6, "type": 14, "label": 1, "typeName": ".google.protobuf.FeatureSet.JsonFormat", "options": { "retention": 1, "targets": [3, 6, 1], "editionDefaults": [{ "value": "LEGACY_BEST_EFFORT", "edition": 900 }, { "value": "ALLOW", "edition": 999 }] } }, { "name": "enforce_naming_style", "number": 7, "type": 14, "label": 1, "typeName": ".google.protobuf.FeatureSet.EnforceNamingStyle", "options": { "retention": 2, "targets": [1, 2, 3, 4, 5, 6, 7, 8, 9], "editionDefaults": [{ "value": "STYLE_LEGACY", "edition": 900 }, { "value": "STYLE2024", "edition": 1001 }] } }, { "name": "default_symbol_visibility", "number": 8, "type": 14, "label": 1, "typeName": ".google.protobuf.FeatureSet.VisibilityFeature.DefaultSymbolVisibility", "options": { "retention": 2, "targets": [1], "editionDefaults": [{ "value": "EXPORT_ALL", "edition": 900 }, { "value": "EXPORT_TOP_LEVEL", "edition": 1001 }] } }], "nestedType": [{ "name": "VisibilityFeature", "enumType": [{ "name": "DefaultSymbolVisibility", "value": [{ "name": "DEFAULT_SYMBOL_VISIBILITY_UNKNOWN", "number": 0 }, { "name": "EXPORT_ALL", "number": 1 }, { "name": "EXPORT_TOP_LEVEL", "number": 2 }, { "name": "LOCAL_ALL", "number": 3 }, { "name": "STRICT", "number": 4 }] }] }], "enumType": [{ "name": "FieldPresence", "value": [{ "name": "FIELD_PRESENCE_UNKNOWN", "number": 0 }, { "name": "EXPLICIT", "number": 1 }, { "name": "IMPLICIT", "number": 2 }, { "name": "LEGACY_REQUIRED", "number": 3 }] }, { "name": "EnumType", "value": [{ "name": "ENUM_TYPE_UNKNOWN", "number": 0 }, { "name": "OPEN", "number": 1 }, { "name": "CLOSED", "number": 2 }] }, { "name": "RepeatedFieldEncoding", "value": [{ "name": "REPEATED_FIELD_ENCODING_UNKNOWN", "number": 0 }, { "name": "PACKED", "number": 1 }, { "name": "EXPANDED", "number": 2 }] }, { "name": "Utf8Validation", "value": [{ "name": "UTF8_VALIDATION_UNKNOWN", "number": 0 }, { "name": "VERIFY", "number": 2 }, { "name": "NONE", "number": 3 }] }, { "name": "MessageEncoding", "value": [{ "name": "MESSAGE_ENCODING_UNKNOWN", "number": 0 }, { "name": "LENGTH_PREFIXED", "number": 1 }, { "name": "DELIMITED", "number": 2 }] }, { "name": "JsonFormat", "value": [{ "name": "JSON_FORMAT_UNKNOWN", "number": 0 }, { "name": "ALLOW", "number": 1 }, { "name": "LEGACY_BEST_EFFORT", "number": 2 }] }, { "name": "EnforceNamingStyle", "value": [{ "name": "ENFORCE_NAMING_STYLE_UNKNOWN", "number": 0 }, { "name": "STYLE2024", "number": 1 }, { "name": "STYLE_LEGACY", "number": 2 }] }], "extensionRange": [{ "start": 1e3, "end": 9995 }, { "start": 9995, "end": 1e4 }, { "start": 1e4, "end": 10001 }] }, { "name": "FeatureSetDefaults", "field": [{ "name": "defaults", "number": 1, "type": 11, "label": 3, "typeName": ".google.protobuf.FeatureSetDefaults.FeatureSetEditionDefault" }, { "name": "minimum_edition", "number": 4, "type": 14, "label": 1, "typeName": ".google.protobuf.Edition" }, { "name": "maximum_edition", "number": 5, "type": 14, "label": 1, "typeName": ".google.protobuf.Edition" }], "nestedType": [{ "name": "FeatureSetEditionDefault", "field": [{ "name": "edition", "number": 3, "type": 14, "label": 1, "typeName": ".google.protobuf.Edition" }, { "name": "overridable_features", "number": 4, "type": 11, "label": 1, "typeName": ".google.protobuf.FeatureSet" }, { "name": "fixed_features", "number": 5, "type": 11, "label": 1, "typeName": ".google.protobuf.FeatureSet" }] }] }, { "name": "SourceCodeInfo", "field": [{ "name": "location", "number": 1, "type": 11, "label": 3, "typeName": ".google.protobuf.SourceCodeInfo.Location" }], "nestedType": [{ "name": "Location", "field": [{ "name": "path", "number": 1, "type": 5, "label": 3, "options": { "packed": true } }, { "name": "span", "number": 2, "type": 5, "label": 3, "options": { "packed": true } }, { "name": "leading_comments", "number": 3, "type": 9, "label": 1 }, { "name": "trailing_comments", "number": 4, "type": 9, "label": 1 }, { "name": "leading_detached_comments", "number": 6, "type": 9, "label": 3 }] }], "extensionRange": [{ "start": 536e6, "end": 536000001 }] }, { "name": "GeneratedCodeInfo", "field": [{ "name": "annotation", "number": 1, "type": 11, "label": 3, "typeName": ".google.protobuf.GeneratedCodeInfo.Annotation" }], "nestedType": [{ "name": "Annotation", "field": [{ "name": "path", "number": 1, "type": 5, "label": 3, "options": { "packed": true } }, { "name": "source_file", "number": 2, "type": 9, "label": 1 }, { "name": "begin", "number": 3, "type": 5, "label": 1 }, { "name": "end", "number": 4, "type": 5, "label": 1 }, { "name": "semantic", "number": 5, "type": 14, "label": 1, "typeName": ".google.protobuf.GeneratedCodeInfo.Annotation.Semantic" }], "enumType": [{ "name": "Semantic", "value": [{ "name": "NONE", "number": 0 }, { "name": "SET", "number": 1 }, { "name": "ALIAS", "number": 2 }] }] }] }], "enumType": [{ "name": "Edition", "value": [{ "name": "EDITION_UNKNOWN", "number": 0 }, { "name": "EDITION_LEGACY", "number": 900 }, { "name": "EDITION_PROTO2", "number": 998 }, { "name": "EDITION_PROTO3", "number": 999 }, { "name": "EDITION_2023", "number": 1e3 }, { "name": "EDITION_2024", "number": 1001 }, { "name": "EDITION_UNSTABLE", "number": 9999 }, { "name": "EDITION_1_TEST_ONLY", "number": 1 }, { "name": "EDITION_2_TEST_ONLY", "number": 2 }, { "name": "EDITION_99997_TEST_ONLY", "number": 99997 }, { "name": "EDITION_99998_TEST_ONLY", "number": 99998 }, { "name": "EDITION_99999_TEST_ONLY", "number": 99999 }, { "name": "EDITION_MAX", "number": 2147483647 }] }, { "name": "SymbolVisibility", "value": [{ "name": "VISIBILITY_UNSET", "number": 0 }, { "name": "VISIBILITY_LOCAL", "number": 1 }, { "name": "VISIBILITY_EXPORT", "number": 2 }] }] });
      FileDescriptorProtoSchema = /* @__PURE__ */ messageDesc(file_google_protobuf_descriptor, 1);
      (function(ExtensionRangeOptions_VerificationState2) {
        ExtensionRangeOptions_VerificationState2[ExtensionRangeOptions_VerificationState2["DECLARATION"] = 0] = "DECLARATION";
        ExtensionRangeOptions_VerificationState2[ExtensionRangeOptions_VerificationState2["UNVERIFIED"] = 1] = "UNVERIFIED";
      })(ExtensionRangeOptions_VerificationState || (ExtensionRangeOptions_VerificationState = {}));
      (function(FieldDescriptorProto_Type2) {
        FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["DOUBLE"] = 1] = "DOUBLE";
        FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["FLOAT"] = 2] = "FLOAT";
        FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["INT64"] = 3] = "INT64";
        FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["UINT64"] = 4] = "UINT64";
        FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["INT32"] = 5] = "INT32";
        FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["FIXED64"] = 6] = "FIXED64";
        FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["FIXED32"] = 7] = "FIXED32";
        FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["BOOL"] = 8] = "BOOL";
        FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["STRING"] = 9] = "STRING";
        FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["GROUP"] = 10] = "GROUP";
        FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["MESSAGE"] = 11] = "MESSAGE";
        FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["BYTES"] = 12] = "BYTES";
        FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["UINT32"] = 13] = "UINT32";
        FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["ENUM"] = 14] = "ENUM";
        FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["SFIXED32"] = 15] = "SFIXED32";
        FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["SFIXED64"] = 16] = "SFIXED64";
        FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["SINT32"] = 17] = "SINT32";
        FieldDescriptorProto_Type2[FieldDescriptorProto_Type2["SINT64"] = 18] = "SINT64";
      })(FieldDescriptorProto_Type || (FieldDescriptorProto_Type = {}));
      (function(FieldDescriptorProto_Label2) {
        FieldDescriptorProto_Label2[FieldDescriptorProto_Label2["OPTIONAL"] = 1] = "OPTIONAL";
        FieldDescriptorProto_Label2[FieldDescriptorProto_Label2["REPEATED"] = 3] = "REPEATED";
        FieldDescriptorProto_Label2[FieldDescriptorProto_Label2["REQUIRED"] = 2] = "REQUIRED";
      })(FieldDescriptorProto_Label || (FieldDescriptorProto_Label = {}));
      (function(FileOptions_OptimizeMode2) {
        FileOptions_OptimizeMode2[FileOptions_OptimizeMode2["SPEED"] = 1] = "SPEED";
        FileOptions_OptimizeMode2[FileOptions_OptimizeMode2["CODE_SIZE"] = 2] = "CODE_SIZE";
        FileOptions_OptimizeMode2[FileOptions_OptimizeMode2["LITE_RUNTIME"] = 3] = "LITE_RUNTIME";
      })(FileOptions_OptimizeMode || (FileOptions_OptimizeMode = {}));
      (function(FieldOptions_CType2) {
        FieldOptions_CType2[FieldOptions_CType2["STRING"] = 0] = "STRING";
        FieldOptions_CType2[FieldOptions_CType2["CORD"] = 1] = "CORD";
        FieldOptions_CType2[FieldOptions_CType2["STRING_PIECE"] = 2] = "STRING_PIECE";
      })(FieldOptions_CType || (FieldOptions_CType = {}));
      (function(FieldOptions_JSType2) {
        FieldOptions_JSType2[FieldOptions_JSType2["JS_NORMAL"] = 0] = "JS_NORMAL";
        FieldOptions_JSType2[FieldOptions_JSType2["JS_STRING"] = 1] = "JS_STRING";
        FieldOptions_JSType2[FieldOptions_JSType2["JS_NUMBER"] = 2] = "JS_NUMBER";
      })(FieldOptions_JSType || (FieldOptions_JSType = {}));
      (function(FieldOptions_OptionRetention2) {
        FieldOptions_OptionRetention2[FieldOptions_OptionRetention2["RETENTION_UNKNOWN"] = 0] = "RETENTION_UNKNOWN";
        FieldOptions_OptionRetention2[FieldOptions_OptionRetention2["RETENTION_RUNTIME"] = 1] = "RETENTION_RUNTIME";
        FieldOptions_OptionRetention2[FieldOptions_OptionRetention2["RETENTION_SOURCE"] = 2] = "RETENTION_SOURCE";
      })(FieldOptions_OptionRetention || (FieldOptions_OptionRetention = {}));
      (function(FieldOptions_OptionTargetType2) {
        FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_UNKNOWN"] = 0] = "TARGET_TYPE_UNKNOWN";
        FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_FILE"] = 1] = "TARGET_TYPE_FILE";
        FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_EXTENSION_RANGE"] = 2] = "TARGET_TYPE_EXTENSION_RANGE";
        FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_MESSAGE"] = 3] = "TARGET_TYPE_MESSAGE";
        FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_FIELD"] = 4] = "TARGET_TYPE_FIELD";
        FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_ONEOF"] = 5] = "TARGET_TYPE_ONEOF";
        FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_ENUM"] = 6] = "TARGET_TYPE_ENUM";
        FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_ENUM_ENTRY"] = 7] = "TARGET_TYPE_ENUM_ENTRY";
        FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_SERVICE"] = 8] = "TARGET_TYPE_SERVICE";
        FieldOptions_OptionTargetType2[FieldOptions_OptionTargetType2["TARGET_TYPE_METHOD"] = 9] = "TARGET_TYPE_METHOD";
      })(FieldOptions_OptionTargetType || (FieldOptions_OptionTargetType = {}));
      (function(MethodOptions_IdempotencyLevel2) {
        MethodOptions_IdempotencyLevel2[MethodOptions_IdempotencyLevel2["IDEMPOTENCY_UNKNOWN"] = 0] = "IDEMPOTENCY_UNKNOWN";
        MethodOptions_IdempotencyLevel2[MethodOptions_IdempotencyLevel2["NO_SIDE_EFFECTS"] = 1] = "NO_SIDE_EFFECTS";
        MethodOptions_IdempotencyLevel2[MethodOptions_IdempotencyLevel2["IDEMPOTENT"] = 2] = "IDEMPOTENT";
      })(MethodOptions_IdempotencyLevel || (MethodOptions_IdempotencyLevel = {}));
      (function(FeatureSet_VisibilityFeature_DefaultSymbolVisibility2) {
        FeatureSet_VisibilityFeature_DefaultSymbolVisibility2[FeatureSet_VisibilityFeature_DefaultSymbolVisibility2["DEFAULT_SYMBOL_VISIBILITY_UNKNOWN"] = 0] = "DEFAULT_SYMBOL_VISIBILITY_UNKNOWN";
        FeatureSet_VisibilityFeature_DefaultSymbolVisibility2[FeatureSet_VisibilityFeature_DefaultSymbolVisibility2["EXPORT_ALL"] = 1] = "EXPORT_ALL";
        FeatureSet_VisibilityFeature_DefaultSymbolVisibility2[FeatureSet_VisibilityFeature_DefaultSymbolVisibility2["EXPORT_TOP_LEVEL"] = 2] = "EXPORT_TOP_LEVEL";
        FeatureSet_VisibilityFeature_DefaultSymbolVisibility2[FeatureSet_VisibilityFeature_DefaultSymbolVisibility2["LOCAL_ALL"] = 3] = "LOCAL_ALL";
        FeatureSet_VisibilityFeature_DefaultSymbolVisibility2[FeatureSet_VisibilityFeature_DefaultSymbolVisibility2["STRICT"] = 4] = "STRICT";
      })(FeatureSet_VisibilityFeature_DefaultSymbolVisibility || (FeatureSet_VisibilityFeature_DefaultSymbolVisibility = {}));
      (function(FeatureSet_FieldPresence2) {
        FeatureSet_FieldPresence2[FeatureSet_FieldPresence2["FIELD_PRESENCE_UNKNOWN"] = 0] = "FIELD_PRESENCE_UNKNOWN";
        FeatureSet_FieldPresence2[FeatureSet_FieldPresence2["EXPLICIT"] = 1] = "EXPLICIT";
        FeatureSet_FieldPresence2[FeatureSet_FieldPresence2["IMPLICIT"] = 2] = "IMPLICIT";
        FeatureSet_FieldPresence2[FeatureSet_FieldPresence2["LEGACY_REQUIRED"] = 3] = "LEGACY_REQUIRED";
      })(FeatureSet_FieldPresence || (FeatureSet_FieldPresence = {}));
      (function(FeatureSet_EnumType2) {
        FeatureSet_EnumType2[FeatureSet_EnumType2["ENUM_TYPE_UNKNOWN"] = 0] = "ENUM_TYPE_UNKNOWN";
        FeatureSet_EnumType2[FeatureSet_EnumType2["OPEN"] = 1] = "OPEN";
        FeatureSet_EnumType2[FeatureSet_EnumType2["CLOSED"] = 2] = "CLOSED";
      })(FeatureSet_EnumType || (FeatureSet_EnumType = {}));
      (function(FeatureSet_RepeatedFieldEncoding2) {
        FeatureSet_RepeatedFieldEncoding2[FeatureSet_RepeatedFieldEncoding2["REPEATED_FIELD_ENCODING_UNKNOWN"] = 0] = "REPEATED_FIELD_ENCODING_UNKNOWN";
        FeatureSet_RepeatedFieldEncoding2[FeatureSet_RepeatedFieldEncoding2["PACKED"] = 1] = "PACKED";
        FeatureSet_RepeatedFieldEncoding2[FeatureSet_RepeatedFieldEncoding2["EXPANDED"] = 2] = "EXPANDED";
      })(FeatureSet_RepeatedFieldEncoding || (FeatureSet_RepeatedFieldEncoding = {}));
      (function(FeatureSet_Utf8Validation2) {
        FeatureSet_Utf8Validation2[FeatureSet_Utf8Validation2["UTF8_VALIDATION_UNKNOWN"] = 0] = "UTF8_VALIDATION_UNKNOWN";
        FeatureSet_Utf8Validation2[FeatureSet_Utf8Validation2["VERIFY"] = 2] = "VERIFY";
        FeatureSet_Utf8Validation2[FeatureSet_Utf8Validation2["NONE"] = 3] = "NONE";
      })(FeatureSet_Utf8Validation || (FeatureSet_Utf8Validation = {}));
      (function(FeatureSet_MessageEncoding2) {
        FeatureSet_MessageEncoding2[FeatureSet_MessageEncoding2["MESSAGE_ENCODING_UNKNOWN"] = 0] = "MESSAGE_ENCODING_UNKNOWN";
        FeatureSet_MessageEncoding2[FeatureSet_MessageEncoding2["LENGTH_PREFIXED"] = 1] = "LENGTH_PREFIXED";
        FeatureSet_MessageEncoding2[FeatureSet_MessageEncoding2["DELIMITED"] = 2] = "DELIMITED";
      })(FeatureSet_MessageEncoding || (FeatureSet_MessageEncoding = {}));
      (function(FeatureSet_JsonFormat2) {
        FeatureSet_JsonFormat2[FeatureSet_JsonFormat2["JSON_FORMAT_UNKNOWN"] = 0] = "JSON_FORMAT_UNKNOWN";
        FeatureSet_JsonFormat2[FeatureSet_JsonFormat2["ALLOW"] = 1] = "ALLOW";
        FeatureSet_JsonFormat2[FeatureSet_JsonFormat2["LEGACY_BEST_EFFORT"] = 2] = "LEGACY_BEST_EFFORT";
      })(FeatureSet_JsonFormat || (FeatureSet_JsonFormat = {}));
      (function(FeatureSet_EnforceNamingStyle2) {
        FeatureSet_EnforceNamingStyle2[FeatureSet_EnforceNamingStyle2["ENFORCE_NAMING_STYLE_UNKNOWN"] = 0] = "ENFORCE_NAMING_STYLE_UNKNOWN";
        FeatureSet_EnforceNamingStyle2[FeatureSet_EnforceNamingStyle2["STYLE2024"] = 1] = "STYLE2024";
        FeatureSet_EnforceNamingStyle2[FeatureSet_EnforceNamingStyle2["STYLE_LEGACY"] = 2] = "STYLE_LEGACY";
      })(FeatureSet_EnforceNamingStyle || (FeatureSet_EnforceNamingStyle = {}));
      (function(GeneratedCodeInfo_Annotation_Semantic2) {
        GeneratedCodeInfo_Annotation_Semantic2[GeneratedCodeInfo_Annotation_Semantic2["NONE"] = 0] = "NONE";
        GeneratedCodeInfo_Annotation_Semantic2[GeneratedCodeInfo_Annotation_Semantic2["SET"] = 1] = "SET";
        GeneratedCodeInfo_Annotation_Semantic2[GeneratedCodeInfo_Annotation_Semantic2["ALIAS"] = 2] = "ALIAS";
      })(GeneratedCodeInfo_Annotation_Semantic || (GeneratedCodeInfo_Annotation_Semantic = {}));
      (function(Edition2) {
        Edition2[Edition2["EDITION_UNKNOWN"] = 0] = "EDITION_UNKNOWN";
        Edition2[Edition2["EDITION_LEGACY"] = 900] = "EDITION_LEGACY";
        Edition2[Edition2["EDITION_PROTO2"] = 998] = "EDITION_PROTO2";
        Edition2[Edition2["EDITION_PROTO3"] = 999] = "EDITION_PROTO3";
        Edition2[Edition2["EDITION_2023"] = 1e3] = "EDITION_2023";
        Edition2[Edition2["EDITION_2024"] = 1001] = "EDITION_2024";
        Edition2[Edition2["EDITION_UNSTABLE"] = 9999] = "EDITION_UNSTABLE";
        Edition2[Edition2["EDITION_1_TEST_ONLY"] = 1] = "EDITION_1_TEST_ONLY";
        Edition2[Edition2["EDITION_2_TEST_ONLY"] = 2] = "EDITION_2_TEST_ONLY";
        Edition2[Edition2["EDITION_99997_TEST_ONLY"] = 99997] = "EDITION_99997_TEST_ONLY";
        Edition2[Edition2["EDITION_99998_TEST_ONLY"] = 99998] = "EDITION_99998_TEST_ONLY";
        Edition2[Edition2["EDITION_99999_TEST_ONLY"] = 99999] = "EDITION_99999_TEST_ONLY";
        Edition2[Edition2["EDITION_MAX"] = 2147483647] = "EDITION_MAX";
      })(Edition || (Edition = {}));
      (function(SymbolVisibility2) {
        SymbolVisibility2[SymbolVisibility2["VISIBILITY_UNSET"] = 0] = "VISIBILITY_UNSET";
        SymbolVisibility2[SymbolVisibility2["VISIBILITY_LOCAL"] = 1] = "VISIBILITY_LOCAL";
        SymbolVisibility2[SymbolVisibility2["VISIBILITY_EXPORT"] = 2] = "VISIBILITY_EXPORT";
      })(SymbolVisibility || (SymbolVisibility = {}));
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/from-binary.js
  function makeReadContext(options) {
    return Object.assign(Object.assign({ readUnknownFields: true, recursionLimit: 100 }, options), { depth: 0 });
  }
  function fromBinary(schema, bytes, options) {
    const msg = reflect(schema, void 0, false);
    readMessage(msg, new BinaryReader(bytes), makeReadContext(options), false, bytes.byteLength);
    return msg.message;
  }
  function readMessage(message, reader, ctx, delimited, lengthOrDelimitedFieldNo) {
    var _a;
    if (++ctx.depth > ctx.recursionLimit) {
      throw new Error(`cannot decode ${message.desc} from binary: maximum recursion depth of ${ctx.recursionLimit} reached`);
    }
    const end = delimited ? reader.len : reader.pos + lengthOrDelimitedFieldNo;
    let fieldNo;
    let wireType;
    const unknownFields = (_a = message.getUnknown()) !== null && _a !== void 0 ? _a : [];
    while (reader.pos < end) {
      [fieldNo, wireType] = reader.tag();
      if (delimited && wireType == WireType.EndGroup) {
        break;
      }
      const field = message.findNumber(fieldNo);
      if (!field) {
        const recursionLimit = ctx.recursionLimit - ctx.depth;
        const data = reader.skip(wireType, fieldNo, recursionLimit);
        if (ctx.readUnknownFields) {
          unknownFields.push({ no: fieldNo, wireType, data });
        }
        continue;
      }
      readField(message, reader, field, wireType, ctx);
    }
    if (delimited) {
      if (wireType != WireType.EndGroup || fieldNo !== lengthOrDelimitedFieldNo) {
        throw new Error("invalid end group tag");
      }
    }
    if (unknownFields.length > 0) {
      message.setUnknown(unknownFields);
    }
    ctx.depth--;
  }
  function readField(message, reader, field, wireType, ctx) {
    var _a;
    switch (field.fieldKind) {
      case "scalar":
        message.set(field, readScalar(reader, field.scalar, field.utf8Validation));
        break;
      case "enum":
        const val = readScalar(reader, ScalarType.INT32);
        if (field.enum.open) {
          message.set(field, val);
        } else {
          const ok = field.enum.values.some((v) => v.number === val);
          if (ok) {
            message.set(field, val);
          } else if (ctx.readUnknownFields) {
            const bytes = [];
            varint32write(val, bytes);
            const unknownFields = (_a = message.getUnknown()) !== null && _a !== void 0 ? _a : [];
            unknownFields.push({
              no: field.number,
              wireType,
              data: new Uint8Array(bytes)
            });
            message.setUnknown(unknownFields);
          }
        }
        break;
      case "message":
        message.set(field, readMessageField(reader, ctx, field, message.get(field)));
        break;
      case "list":
        readListField(reader, wireType, message.get(field), ctx);
        break;
      case "map":
        readMapEntry(reader, message.get(field), ctx);
        break;
    }
  }
  function readMapEntry(reader, map, ctx) {
    const field = map.field();
    let key;
    let val;
    const len = reader.uint32();
    const end = reader.pos + len;
    while (reader.pos < end) {
      const [fieldNo] = reader.tag();
      switch (fieldNo) {
        case 1:
          key = readScalar(reader, field.mapKey, field.utf8Validation);
          break;
        case 2:
          switch (field.mapKind) {
            case "scalar":
              val = readScalar(reader, field.scalar, field.utf8Validation);
              break;
            case "enum":
              val = reader.int32();
              break;
            case "message":
              val = readMessageField(reader, ctx, field);
              break;
          }
          break;
      }
    }
    if (key === void 0) {
      key = scalarZeroValue(field.mapKey, false);
    }
    if (val === void 0) {
      switch (field.mapKind) {
        case "scalar":
          val = scalarZeroValue(field.scalar, false);
          break;
        case "enum":
          val = field.enum.values[0].number;
          break;
        case "message":
          val = reflect(field.message, void 0, false);
          break;
      }
    }
    map.set(key, val);
  }
  function readListField(reader, wireType, list, ctx) {
    var _a;
    const field = list.field();
    if (field.listKind === "message") {
      list.add(readMessageField(reader, ctx, field));
      return;
    }
    const scalarType = (_a = field.scalar) !== null && _a !== void 0 ? _a : ScalarType.INT32;
    const packed = wireType == WireType.LengthDelimited && scalarType != ScalarType.STRING && scalarType != ScalarType.BYTES;
    if (!packed) {
      list.add(readScalar(reader, scalarType, field.utf8Validation));
      return;
    }
    const e = reader.uint32() + reader.pos;
    while (reader.pos < e) {
      list.add(readScalar(reader, scalarType, field.utf8Validation));
    }
  }
  function readMessageField(reader, ctx, field, mergeMessage) {
    const delimited = field.delimitedEncoding;
    const message = mergeMessage !== null && mergeMessage !== void 0 ? mergeMessage : reflect(field.message, void 0, false);
    readMessage(message, reader, ctx, delimited, delimited ? field.number : reader.uint32());
    return message;
  }
  function readScalar(reader, type, validateUtf8 = false) {
    switch (type) {
      case ScalarType.STRING:
        return reader.string(validateUtf8);
      case ScalarType.BOOL:
        return reader.bool();
      case ScalarType.DOUBLE:
        return reader.double();
      case ScalarType.FLOAT:
        return reader.float();
      case ScalarType.INT32:
        return reader.int32();
      case ScalarType.INT64:
        return reader.int64();
      case ScalarType.UINT64:
        return reader.uint64();
      case ScalarType.FIXED64:
        return reader.fixed64();
      case ScalarType.BYTES:
        return reader.bytes();
      case ScalarType.FIXED32:
        return reader.fixed32();
      case ScalarType.SFIXED32:
        return reader.sfixed32();
      case ScalarType.SFIXED64:
        return reader.sfixed64();
      case ScalarType.SINT64:
        return reader.sint64();
      case ScalarType.UINT32:
        return reader.uint32();
      case ScalarType.SINT32:
        return reader.sint32();
    }
  }
  var init_from_binary = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/from-binary.js"() {
      init_descriptors();
      init_scalar();
      init_reflect();
      init_binary_encoding();
      init_varint();
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/codegenv2/file.js
  function fileDesc(b64, imports) {
    var _a;
    const root = fromBinary(FileDescriptorProtoSchema, base64Decode(b64));
    root.messageType.forEach(restoreJsonNames);
    root.dependency = (_a = imports === null || imports === void 0 ? void 0 : imports.map((f) => f.proto.name)) !== null && _a !== void 0 ? _a : [];
    const reg = createFileRegistry(root, (protoFileName) => imports === null || imports === void 0 ? void 0 : imports.find((f) => f.proto.name === protoFileName));
    return reg.getFile(root.name);
  }
  var init_file = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/codegenv2/file.js"() {
      init_base64_encoding();
      init_descriptor_pb();
      init_registry();
      init_restore_json_names();
      init_from_binary();
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/to-binary.js
  function makeWriteOptions(options) {
    return options ? Object.assign(Object.assign({}, writeDefaults), options) : writeDefaults;
  }
  function toBinary(schema, message, options) {
    return writeFields(new BinaryWriter(), makeWriteOptions(options), reflect(schema, message)).finish();
  }
  function writeFields(writer, opts, msg) {
    var _a;
    for (const f of msg.sortedFields) {
      if (!msg.isSet(f)) {
        if (f.presence == LEGACY_REQUIRED2) {
          throw new Error(`cannot encode ${f} to binary: required field not set`);
        }
        continue;
      }
      writeField(writer, opts, msg, f);
    }
    if (opts.writeUnknownFields) {
      for (const { no, wireType, data } of (_a = msg.getUnknown()) !== null && _a !== void 0 ? _a : []) {
        writer.tag(no, wireType).raw(data);
      }
    }
    return writer;
  }
  function writeField(writer, opts, msg, field) {
    var _a;
    switch (field.fieldKind) {
      case "scalar":
      case "enum":
        writeScalar(writer, msg.desc.typeName, field.name, (_a = field.scalar) !== null && _a !== void 0 ? _a : ScalarType.INT32, field.number, msg.get(field));
        break;
      case "list":
        writeListField(writer, opts, field, msg.get(field));
        break;
      case "message":
        writeMessageField(writer, opts, field, msg.get(field));
        break;
      case "map":
        for (const [key, val] of msg.get(field)) {
          writeMapEntry(writer, opts, field, key, val);
        }
        break;
    }
  }
  function writeScalar(writer, msgName, fieldName, scalarType, fieldNo, value) {
    writeScalarValue(writer.tag(fieldNo, writeTypeOfScalar(scalarType)), msgName, fieldName, scalarType, value);
  }
  function writeMessageField(writer, opts, field, message) {
    if (field.delimitedEncoding) {
      writeFields(writer.tag(field.number, WireType.StartGroup), opts, message).tag(field.number, WireType.EndGroup);
    } else {
      writeFields(writer.tag(field.number, WireType.LengthDelimited).fork(), opts, message).join();
    }
  }
  function writeListField(writer, opts, field, list) {
    var _a;
    if (field.listKind == "message") {
      for (const item of list) {
        writeMessageField(writer, opts, field, item);
      }
      return;
    }
    const scalarType = (_a = field.scalar) !== null && _a !== void 0 ? _a : ScalarType.INT32;
    if (field.packed) {
      if (!list.size) {
        return;
      }
      writer.tag(field.number, WireType.LengthDelimited).fork();
      for (const item of list) {
        writeScalarValue(writer, field.parent.typeName, field.name, scalarType, item);
      }
      writer.join();
      return;
    }
    for (const item of list) {
      writeScalar(writer, field.parent.typeName, field.name, scalarType, field.number, item);
    }
  }
  function writeMapEntry(writer, opts, field, key, value) {
    var _a;
    writer.tag(field.number, WireType.LengthDelimited).fork();
    writeScalar(writer, field.parent.typeName, field.name, field.mapKey, 1, key);
    switch (field.mapKind) {
      case "scalar":
      case "enum":
        writeScalar(writer, field.parent.typeName, field.name, (_a = field.scalar) !== null && _a !== void 0 ? _a : ScalarType.INT32, 2, value);
        break;
      case "message":
        writeFields(writer.tag(2, WireType.LengthDelimited).fork(), opts, value).join();
        break;
    }
    writer.join();
  }
  function writeScalarValue(writer, msgName, fieldName, type, value) {
    try {
      switch (type) {
        case ScalarType.STRING:
          writer.string(value);
          break;
        case ScalarType.BOOL:
          writer.bool(value);
          break;
        case ScalarType.DOUBLE:
          writer.double(value);
          break;
        case ScalarType.FLOAT:
          writer.float(value);
          break;
        case ScalarType.INT32:
          writer.int32(value);
          break;
        case ScalarType.INT64:
          writer.int64(value);
          break;
        case ScalarType.UINT64:
          writer.uint64(value);
          break;
        case ScalarType.FIXED64:
          writer.fixed64(value);
          break;
        case ScalarType.BYTES:
          writer.bytes(value);
          break;
        case ScalarType.FIXED32:
          writer.fixed32(value);
          break;
        case ScalarType.SFIXED32:
          writer.sfixed32(value);
          break;
        case ScalarType.SFIXED64:
          writer.sfixed64(value);
          break;
        case ScalarType.SINT64:
          writer.sint64(value);
          break;
        case ScalarType.UINT32:
          writer.uint32(value);
          break;
        case ScalarType.SINT32:
          writer.sint32(value);
          break;
      }
    } catch (e) {
      if (e instanceof Error) {
        throw new Error(`cannot encode field ${msgName}.${fieldName} to binary: ${e.message}`);
      }
      throw e;
    }
  }
  function writeTypeOfScalar(type) {
    switch (type) {
      case ScalarType.BYTES:
      case ScalarType.STRING:
        return WireType.LengthDelimited;
      case ScalarType.DOUBLE:
      case ScalarType.FIXED64:
      case ScalarType.SFIXED64:
        return WireType.Bit64;
      case ScalarType.FIXED32:
      case ScalarType.SFIXED32:
      case ScalarType.FLOAT:
        return WireType.Bit32;
      default:
        return WireType.Varint;
    }
  }
  var LEGACY_REQUIRED2, writeDefaults;
  var init_to_binary = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/to-binary.js"() {
      init_reflect();
      init_binary_encoding();
      init_descriptors();
      LEGACY_REQUIRED2 = 3;
      writeDefaults = {
        writeUnknownFields: true
      };
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/codegenv2/extension.js
  var init_extension = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/codegenv2/extension.js"() {
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/equals.js
  var init_equals = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/equals.js"() {
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/fields.js
  function isFieldSet(message, field) {
    return field.parent.typeName == message.$typeName && unsafeIsSet(message, field);
  }
  var init_fields = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/fields.js"() {
      init_unsafe();
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/to-json.js
  var init_to_json = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/to-json.js"() {
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/from-json.js
  var tokenIgnoredUnknownEnum;
  var init_from_json = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/from-json.js"() {
      tokenIgnoredUnknownEnum = Symbol();
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/merge.js
  var init_merge = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/merge.js"() {
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/index.js
  var init_esm = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/index.js"() {
      init_types();
      init_is_message();
      init_create();
      init_clone();
      init_descriptors();
      init_equals();
      init_fields();
      init_registry();
      init_to_binary();
      init_from_binary();
      init_to_json();
      init_from_json();
      init_merge();
      init_proto_int64();
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/codegenv2/embed.js
  var init_embed = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/codegenv2/embed.js"() {
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/codegenv2/service.js
  var init_service = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/codegenv2/service.js"() {
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/codegenv2/symbols.js
  var packageName, wktPublicImportPaths, symbols;
  var init_symbols = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/codegenv2/symbols.js"() {
      packageName = "@bufbuild/protobuf";
      wktPublicImportPaths = {
        "google/protobuf/compiler/plugin.proto": packageName + "/wkt",
        "google/protobuf/any.proto": packageName + "/wkt",
        "google/protobuf/api.proto": packageName + "/wkt",
        "google/protobuf/cpp_features.proto": packageName + "/wkt",
        "google/protobuf/descriptor.proto": packageName + "/wkt",
        "google/protobuf/duration.proto": packageName + "/wkt",
        "google/protobuf/empty.proto": packageName + "/wkt",
        "google/protobuf/field_mask.proto": packageName + "/wkt",
        "google/protobuf/go_features.proto": packageName + "/wkt",
        "google/protobuf/java_features.proto": packageName + "/wkt",
        "google/protobuf/source_context.proto": packageName + "/wkt",
        "google/protobuf/struct.proto": packageName + "/wkt",
        "google/protobuf/timestamp.proto": packageName + "/wkt",
        "google/protobuf/type.proto": packageName + "/wkt",
        "google/protobuf/wrappers.proto": packageName + "/wkt"
      };
      symbols = {
        isMessage: { typeOnly: false, bootstrapWktFrom: "../../is-message.js", from: packageName },
        Message: { typeOnly: true, bootstrapWktFrom: "../../types.js", from: packageName },
        create: { typeOnly: false, bootstrapWktFrom: "../../create.js", from: packageName },
        fromJson: { typeOnly: false, bootstrapWktFrom: "../../from-json.js", from: packageName },
        fromJsonString: { typeOnly: false, bootstrapWktFrom: "../../from-json.js", from: packageName },
        fromBinary: { typeOnly: false, bootstrapWktFrom: "../../from-binary.js", from: packageName },
        toBinary: { typeOnly: false, bootstrapWktFrom: "../../to-binary.js", from: packageName },
        toJson: { typeOnly: false, bootstrapWktFrom: "../../to-json.js", from: packageName },
        toJsonString: { typeOnly: false, bootstrapWktFrom: "../../to-json.js", from: packageName },
        protoInt64: { typeOnly: false, bootstrapWktFrom: "../../proto-int64.js", from: packageName },
        JsonValue: { typeOnly: true, bootstrapWktFrom: "../../json-value.js", from: packageName },
        JsonObject: { typeOnly: true, bootstrapWktFrom: "../../json-value.js", from: packageName },
        codegen: {
          boot: { typeOnly: false, bootstrapWktFrom: "../../codegenv2/boot.js", from: packageName + "/codegenv2" },
          fileDesc: { typeOnly: false, bootstrapWktFrom: "../../codegenv2/file.js", from: packageName + "/codegenv2" },
          enumDesc: { typeOnly: false, bootstrapWktFrom: "../../codegenv2/enum.js", from: packageName + "/codegenv2" },
          extDesc: { typeOnly: false, bootstrapWktFrom: "../../codegenv2/extension.js", from: packageName + "/codegenv2" },
          messageDesc: { typeOnly: false, bootstrapWktFrom: "../../codegenv2/message.js", from: packageName + "/codegenv2" },
          serviceDesc: { typeOnly: false, bootstrapWktFrom: "../../codegenv2/service.js", from: packageName + "/codegenv2" },
          tsEnum: { typeOnly: false, bootstrapWktFrom: "../../codegenv2/enum.js", from: packageName + "/codegenv2" },
          GenFile: { typeOnly: true, bootstrapWktFrom: "../../codegenv2/types.js", from: packageName + "/codegenv2" },
          GenEnum: { typeOnly: true, bootstrapWktFrom: "../../codegenv2/types.js", from: packageName + "/codegenv2" },
          GenExtension: { typeOnly: true, bootstrapWktFrom: "../../codegenv2/types.js", from: packageName + "/codegenv2" },
          GenMessage: { typeOnly: true, bootstrapWktFrom: "../../codegenv2/types.js", from: packageName + "/codegenv2" },
          GenService: { typeOnly: true, bootstrapWktFrom: "../../codegenv2/types.js", from: packageName + "/codegenv2" }
        }
      };
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/codegenv2/scalar.js
  var init_scalar2 = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/codegenv2/scalar.js"() {
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/codegenv2/types.js
  var init_types2 = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/codegenv2/types.js"() {
    }
  });

  // node_modules/@bufbuild/protobuf/dist/esm/codegenv2/index.js
  var init_codegenv2 = __esm({
    "node_modules/@bufbuild/protobuf/dist/esm/codegenv2/index.js"() {
      init_boot();
      init_embed();
      init_enum();
      init_extension();
      init_file();
      init_message();
      init_service();
      init_symbols();
      init_scalar2();
      init_types2();
    }
  });

  // vendor/icloud-md/src/notes/gen/topotext_pb.ts
  var file_topotext, StringSchema, CharIDSchema, SubstringSchema, VectorTimestampSchema, VectorTimestamp_ClockSchema, VectorTimestamp_Clock_ReplicaClockSchema, AttributeRunSchema;
  var init_topotext_pb = __esm({
    "vendor/icloud-md/src/notes/gen/topotext_pb.ts"() {
      init_codegenv2();
      file_topotext = /* @__PURE__ */ fileDesc("Cg50b3BvdGV4dC5wcm90bxIIdG9wb3RleHQinAEKBlN0cmluZxIOCgZzdHJpbmcYAiACKAkSJgoJc3Vic3RyaW5nGAMgAygLMhMudG9wb3RleHQuU3Vic3RyaW5nEiwKCXRpbWVzdGFtcBgEIAEoCzIZLnRvcG90ZXh0LlZlY3RvclRpbWVzdGFtcBIsCgxhdHRyaWJ1dGVSdW4YBSADKAsyFi50b3BvdGV4dC5BdHRyaWJ1dGVSdW4iKgoGQ2hhcklEEhEKCXJlcGxpY2FJRBgBIAIoDRINCgVjbG9jaxgCIAIoDSKEAQoJU3Vic3RyaW5nEiAKBmNoYXJJRBgBIAIoCzIQLnRvcG90ZXh0LkNoYXJJRBIOCgZsZW5ndGgYAiACKA0SIwoJdGltZXN0YW1wGAMgAigLMhAudG9wb3RleHQuQ2hhcklEEhEKCXRvbWJzdG9uZRgEIAEoDRINCgVjaGlsZBgFIAMoDSLVAQoPVmVjdG9yVGltZXN0YW1wEi4KBWNsb2NrGAEgAygLMh8udG9wb3RleHQuVmVjdG9yVGltZXN0YW1wLkNsb2NrGpEBCgVDbG9jaxITCgtyZXBsaWNhVVVJRBgBIAIoDBJCCgxyZXBsaWNhQ2xvY2sYAiADKAsyLC50b3BvdGV4dC5WZWN0b3JUaW1lc3RhbXAuQ2xvY2suUmVwbGljYUNsb2NrGi8KDFJlcGxpY2FDbG9jaxINCgVjbG9jaxgBIAIoDRIQCghzdWJjbG9jaxgCIAEoDSJACgVDb2xvchILCgNyZWQYASACKAISDQoFZ3JlZW4YAiACKAISDAoEYmx1ZRgDIAIoAhINCgVhbHBoYRgEIAIoAiKAAQoOQXR0YWNobWVudEluZm8SHAoUYXR0YWNobWVudElkZW50aWZpZXIYASABKAkSDwoHdHlwZVVUSRgCIAEoCRIhChlzeXN0ZW1BdHRhY2htZW50Q2xhc3NOYW1lGAMgASgJEhwKFHN5c3RlbUF0dGFjaG1lbnREYXRhGAQgASgMIjoKBEZvbnQSDAoEbmFtZRgBIAEoCRIRCglwb2ludFNpemUYAiABKAISEQoJZm9udEhpbnRzGAMgASgNIiYKBFRvZG8SEAoIdG9kb1VVSUQYASACKAwSDAoEZG9uZRgCIAIoDSLZAQoOUGFyYWdyYXBoU3R5bGUSDQoFc3R5bGUYASABKA0SEQoJYWxpZ25tZW50GAIgASgNEhgKEHdyaXRpbmdEaXJlY3Rpb24YAyABKA0SDgoGaW5kZW50GAQgASgFEhwKBHRvZG8YBSABKAsyDi50b3BvdGV4dC5Ub2RvEhYKDnBhcmFncmFwaEhpbnRzGAYgASgNEh4KFnN0YXJ0aW5nTGlzdEl0ZW1OdW1iZXIYByABKA0SFwoPYmxvY2tRdW90ZUxldmVsGAggASgNEgwKBHV1aWQYCSABKAwilwMKDEF0dHJpYnV0ZVJ1bhIOCgZsZW5ndGgYASACKA0SMAoOcGFyYWdyYXBoU3R5bGUYAiABKAsyGC50b3BvdGV4dC5QYXJhZ3JhcGhTdHlsZRIcCgRmb250GAMgASgLMg4udG9wb3RleHQuRm9udBIRCglmb250SGludHMYBSABKA0SEQoJdW5kZXJsaW5lGAYgASgNEhUKDXN0cmlrZXRocm91Z2gYByABKA0SEwoLc3VwZXJzY3JpcHQYCCABKAUSDAoEbGluaxgJIAEoCRIeCgVjb2xvchgKIAEoCzIPLnRvcG90ZXh0LkNvbG9yEhgKEHdyaXRpbmdEaXJlY3Rpb24YCyABKA0SMAoOYXR0YWNobWVudEluZm8YDCABKAsyGC50b3BvdGV4dC5BdHRhY2htZW50SW5mbxIRCgl0aW1lc3RhbXAYDSABKAQSEAoIZW1waGFzaXMYDiABKA0SNgoUc3lzdGVtQXR0YWNobWVudEluZm8YDyABKAsyGC50b3BvdGV4dC5BdHRhY2htZW50SW5mbw");
      StringSchema = /* @__PURE__ */ messageDesc(file_topotext, 0);
      CharIDSchema = /* @__PURE__ */ messageDesc(file_topotext, 1);
      SubstringSchema = /* @__PURE__ */ messageDesc(file_topotext, 2);
      VectorTimestampSchema = /* @__PURE__ */ messageDesc(file_topotext, 3);
      VectorTimestamp_ClockSchema = /* @__PURE__ */ messageDesc(file_topotext, 3, 0);
      VectorTimestamp_Clock_ReplicaClockSchema = /* @__PURE__ */ messageDesc(file_topotext, 3, 0, 0);
      AttributeRunSchema = /* @__PURE__ */ messageDesc(file_topotext, 9);
    }
  });

  // node_modules/node-diff3/dist/diff3.mjs
  function LCS(buffer1, buffer2) {
    let equivalenceClasses = /* @__PURE__ */ Object.create(null);
    for (let j = 0; j < buffer2.length; j++) {
      const item = buffer2[j];
      if (equivalenceClasses[item]) {
        equivalenceClasses[item].push(j);
      } else {
        equivalenceClasses[item] = [j];
      }
    }
    const NULLRESULT = { buffer1index: -1, buffer2index: -1, chain: null };
    let candidates = [NULLRESULT];
    for (let i = 0; i < buffer1.length; i++) {
      const item = buffer1[i];
      const buffer2indices = equivalenceClasses[item] || [];
      let r = 0;
      let c = candidates[0];
      for (const j of buffer2indices) {
        let s;
        for (s = r; s < candidates.length; s++) {
          if (candidates[s].buffer2index < j && (s === candidates.length - 1 || candidates[s + 1].buffer2index > j)) {
            break;
          }
        }
        if (s < candidates.length) {
          const newCandidate = { buffer1index: i, buffer2index: j, chain: candidates[s] };
          if (r === candidates.length) {
            candidates.push(c);
          } else {
            candidates[r] = c;
          }
          r = s + 1;
          c = newCandidate;
          if (r === candidates.length) {
            break;
          }
        }
      }
      candidates[r] = c;
    }
    return candidates[candidates.length - 1];
  }
  function diffIndices(buffer1, buffer2) {
    const lcs = LCS(buffer1, buffer2);
    let result = [];
    let tail1 = buffer1.length;
    let tail2 = buffer2.length;
    for (let candidate = lcs; candidate !== null; candidate = candidate.chain) {
      const mismatchLength1 = tail1 - candidate.buffer1index - 1;
      const mismatchLength2 = tail2 - candidate.buffer2index - 1;
      tail1 = candidate.buffer1index;
      tail2 = candidate.buffer2index;
      if (mismatchLength1 || mismatchLength2) {
        result.push({
          buffer1: [tail1 + 1, mismatchLength1],
          buffer1Content: buffer1.slice(tail1 + 1, tail1 + 1 + mismatchLength1),
          buffer2: [tail2 + 1, mismatchLength2],
          buffer2Content: buffer2.slice(tail2 + 1, tail2 + 1 + mismatchLength2)
        });
      }
    }
    result.reverse();
    return result;
  }
  var init_diff3 = __esm({
    "node_modules/node-diff3/dist/diff3.mjs"() {
    }
  });

  // vendor/icloud-md/src/notes/gen/versioned_document_pb.ts
  var file_versioned_document, DocumentSchema, VersionSchema;
  var init_versioned_document_pb = __esm({
    "vendor/icloud-md/src/notes/gen/versioned_document_pb.ts"() {
      init_codegenv2();
      file_versioned_document = /* @__PURE__ */ fileDesc("Chh2ZXJzaW9uZWRfZG9jdW1lbnQucHJvdG8SEnZlcnNpb25lZF9kb2N1bWVudCJWCghEb2N1bWVudBIcChRzZXJpYWxpemF0aW9uVmVyc2lvbhgBIAEoDRIsCgd2ZXJzaW9uGAIgAygLMhsudmVyc2lvbmVkX2RvY3VtZW50LlZlcnNpb24iVgoHVmVyc2lvbhIcChRzZXJpYWxpemF0aW9uVmVyc2lvbhgBIAEoDRIfChdtaW5pbXVtU3VwcG9ydGVkVmVyc2lvbhgCIAEoDRIMCgRkYXRhGAMgASgM");
      DocumentSchema = /* @__PURE__ */ messageDesc(file_versioned_document, 0);
      VersionSchema = /* @__PURE__ */ messageDesc(file_versioned_document, 1);
    }
  });

  // vendor/icloud-md/src/notes/versionedDocument.ts
  function parseVersionedDocument(raw) {
    const wrapper = fromBinary(DocumentSchema, raw);
    const version = wrapper.version.length === 1 ? wrapper.version[0] : void 0;
    if (!version) {
      throw new Error(`Versioned document has ${wrapper.version.length} versions - only exactly one is understood`);
    }
    if (!isFieldSet(version, DATA_FIELD)) {
      throw new Error("Versioned document's version carries no data payload");
    }
    return { wrapper, data: version.data };
  }
  var DATA_FIELD;
  var init_versionedDocument = __esm({
    "vendor/icloud-md/src/notes/versionedDocument.ts"() {
      init_esm();
      init_versioned_document_pb();
      DATA_FIELD = VersionSchema.fields.find((f) => f.localName === "data");
    }
  });

  // vendor/icloud-md/src/notes/noteDocument.ts
  function parseNoteDocument(raw) {
    const { wrapper, data } = parseVersionedDocument(raw);
    const version = wrapper.version[0];
    const str = fromBinary(StringSchema, data);
    if (!str.timestamp) {
      throw new Error("Note document is missing its replica clock table (String field 4)");
    }
    return {
      rootSerializationVersion: wrapper.serializationVersion,
      versionSerializationVersion: version.serializationVersion,
      minimumSupportedVersion: version.minimumSupportedVersion,
      text: str.string,
      runs: str.substring.map(parseTextRun),
      replicas: str.timestamp.clock.map(parseReplicaEntry),
      attributeRuns: str.attributeRun
    };
  }
  function encodeNoteDocument(doc) {
    const str = create(StringSchema, {
      string: doc.text,
      substring: doc.runs.map(encodeTextRun),
      timestamp: create(VectorTimestampSchema, { clock: doc.replicas.map(encodeReplicaEntry) }),
      attributeRun: doc.attributeRuns
    });
    const wrapper = create(DocumentSchema, {
      serializationVersion: doc.rootSerializationVersion,
      version: [
        create(VersionSchema, {
          serializationVersion: doc.versionSerializationVersion,
          minimumSupportedVersion: doc.minimumSupportedVersion,
          data: toBinary(StringSchema, str)
        })
      ]
    });
    return toBinary(DocumentSchema, wrapper);
  }
  function noteDocumentRoundTrips(raw) {
    let reencoded;
    try {
      reencoded = encodeNoteDocument(parseNoteDocument(raw));
    } catch (e) {
      return false;
    }
    return bytesEqual(raw, reencoded);
  }
  function applyTextEdit(doc, newText, options) {
    const oldText = doc.text;
    if (oldText === newText) {
      return false;
    }
    validateDocumentInvariants(doc);
    const splices = computeSplices(oldText, newText);
    const replicaIndex = ensureReplica(doc, options.replicaId);
    const styleClockFloor = styleClockSeed(doc, replicaIndex);
    let maxAssignedStyleClock = -1;
    let structuralChange = false;
    let insertedNewRun = false;
    let delta = 0;
    for (const { start: oldStart, deleteLength, insertText } of splices) {
      const start = oldStart + delta;
      if (deleteLength > 0) {
        maxAssignedStyleClock = Math.max(
          maxAssignedStyleClock,
          tombstoneVisibleRange(doc, start, deleteLength, replicaIndex, styleClockFloor)
        );
        structuralChange = true;
      }
      if (insertText.length > 0) {
        const newRun = insertVisibleText(doc, start, insertText, replicaIndex);
        insertedNewRun = insertedNewRun || newRun;
        structuralChange = newRun || structuralChange;
      }
      adjustAttributeRuns(doc, start, deleteLength, insertText.length);
      delta += insertText.length - deleteLength;
    }
    if (structuralChange) {
      const replica = doc.replicas[replicaIndex - 1];
      if (replica) {
        replica.counters[1] = Math.max(maxAssignedStyleClock + 1, styleClockFloor, insertedNewRun ? 1 : 0);
      }
    }
    doc.text = newText;
    validateDocumentInvariants(doc);
    return true;
  }
  function shiftChildEdges(runs, threshold, delta) {
    for (const run of runs) {
      for (let i = 0; i < run.sequence.length; i += 1) {
        if (run.sequence[i] >= threshold) {
          run.sequence[i] += delta;
        }
      }
    }
  }
  function splitRunAt(runs, index, offset) {
    const run = runs[index];
    if (!run || offset <= 0 || offset >= run.length) {
      throw new Error(`Cannot split run ${index} at offset ${offset} - CRDT model out of sync`);
    }
    shiftChildEdges(runs, index + 1, 1);
    const tail = {
      coord: { replica: run.coord.replica, clock: run.coord.clock + offset },
      length: run.length - offset,
      anchor: { replica: run.anchor.replica, clock: run.anchor.clock },
      tombstone: run.tombstone,
      // Ownership of the outgoing edges moves to the tail (values already
      // shifted above; they all pointed past `index`, this array is not
      // shared - every run's sequence array has one owner).
      sequence: run.sequence
    };
    run.length = offset;
    run.sequence = [index + 1];
    runs.splice(index + 1, 0, tail);
    return tail;
  }
  function insertRunAt(runs, index, run) {
    shiftChildEdges(runs, index, 1);
    const predecessor = index > 0 ? runs[index - 1] : void 0;
    if (predecessor) {
      const successorEdge = predecessor.sequence.indexOf(index + 1);
      if (successorEdge !== -1) {
        predecessor.sequence[successorEdge] = index;
        run.sequence = [index + 1];
      } else {
        run.sequence = predecessor.sequence;
        predecessor.sequence = [index];
      }
    } else {
      run.sequence = [index + 1];
    }
    runs.splice(index, 0, run);
  }
  function parseTextRun(run) {
    const coord = run.charID;
    const anchor = run.timestamp;
    if (!coord || !anchor) {
      throw new Error("Substring is missing charID, length, or timestamp");
    }
    let tombstone = false;
    if (isFieldSet(run, TOMBSTONE_FIELD)) {
      if (run.tombstone !== 1) {
        throw new Error(`Substring tombstone flag has unexpected value ${run.tombstone}`);
      }
      tombstone = true;
    }
    return {
      coord: { replica: coord.replicaID, clock: coord.clock },
      length: run.length,
      anchor: { replica: anchor.replicaID, clock: anchor.clock },
      tombstone,
      sequence: run.child
    };
  }
  function parseReplicaEntry(entry) {
    if (entry.replicaUUID.length !== 16) {
      throw new Error("Replica clock entry does not start with a 16-byte UUID");
    }
    return {
      id: entry.replicaUUID,
      counters: entry.replicaClock.map((counter) => {
        if (isFieldSet(counter, SUBCLOCK_FIELD)) {
          throw new Error("Replica clock entry carries a subclock this tool doesn't understand - refusing to touch this note");
        }
        return counter.clock;
      })
    };
  }
  function encodeTextRun(run) {
    return create(SubstringSchema, __spreadProps(__spreadValues({
      charID: create(CharIDSchema, { replicaID: run.coord.replica, clock: run.coord.clock }),
      length: run.length,
      timestamp: create(CharIDSchema, { replicaID: run.anchor.replica, clock: run.anchor.clock })
    }, run.tombstone ? { tombstone: 1 } : {}), {
      child: run.sequence
    }));
  }
  function encodeReplicaEntry(entry) {
    return create(VectorTimestamp_ClockSchema, {
      replicaUUID: entry.id,
      replicaClock: entry.counters.map((clock) => create(VectorTimestamp_Clock_ReplicaClockSchema, { clock }))
    });
  }
  function computeSplice(oldText, newText) {
    let prefix = 0;
    const maxPrefix = Math.min(oldText.length, newText.length);
    while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) {
      prefix += 1;
    }
    while (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) {
      prefix -= 1;
    }
    let suffix = 0;
    const maxSuffix = Math.min(oldText.length, newText.length) - prefix;
    while (suffix < maxSuffix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) {
      suffix += 1;
    }
    while (suffix > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - suffix))) {
      suffix -= 1;
    }
    return {
      start: prefix,
      deleteLength: oldText.length - prefix - suffix,
      insertText: newText.slice(prefix, newText.length - suffix)
    };
  }
  function computeSplices(oldText, newText) {
    if (oldText === newText) {
      return [];
    }
    const oldLines = splitLinesInclusive(oldText);
    const newLines = splitLinesInclusive(newText);
    const oldOffsets = lineStartOffsets(oldLines);
    const newOffsets = lineStartOffsets(newLines);
    const splices = [];
    for (const hunk of diffIndices(oldLines, newLines)) {
      const oldStart = oldOffsets[hunk.buffer1[0]];
      const oldHunk = hunk.buffer1Content.join("");
      const newStart = newOffsets[hunk.buffer2[0]];
      const newHunk = hunk.buffer2Content.join("");
      const inner = computeSplice(oldHunk, newHunk);
      if (inner.deleteLength === 0 && inner.insertText.length === 0) {
        continue;
      }
      splices.push({ start: oldStart + inner.start, deleteLength: inner.deleteLength, insertText: inner.insertText });
    }
    return splices;
  }
  function splitLinesInclusive(text) {
    const lines = text.split("\n").map((line) => `${line}
`);
    const last = lines[lines.length - 1];
    if (last === "\n") {
      lines.pop();
    } else {
      lines[lines.length - 1] = last.slice(0, -1);
    }
    return lines;
  }
  function lineStartOffsets(lines) {
    const offsets = [0];
    for (const line of lines) {
      offsets.push(offsets[offsets.length - 1] + line.length);
    }
    return offsets;
  }
  function isHighSurrogate(code) {
    return code >= 55296 && code <= 56319;
  }
  function isLowSurrogate(code) {
    return code >= 56320 && code <= 57343;
  }
  function tombstoneVisibleRange(doc, start, length, replicaIndex, styleClockFloor) {
    const end = start + length;
    if (end > visibleLengthFrom(doc.runs, 0)) {
      throw new Error("Tombstone range extends past the end of the visible text - CRDT model out of sync");
    }
    const runs = doc.runs;
    let visible = 0;
    let maxAssigned = -1;
    for (let i = 0; i < runs.length && visible < end; i += 1) {
      const run = runs[i];
      if (run.tombstone || run.length === 0 || isSentinel(run)) {
        continue;
      }
      const runStart = visible;
      const runEnd = runStart + run.length;
      if (runEnd <= start) {
        visible = runEnd;
        continue;
      }
      let target = run;
      let targetIndex = i;
      let targetStart = runStart;
      if (start > runStart) {
        target = splitRunAt(runs, i, start - runStart);
        targetIndex = i + 1;
        targetStart = start;
      }
      if (end < targetStart + target.length) {
        splitRunAt(runs, targetIndex, end - targetStart);
      }
      const assigned = Math.max(target.anchor.clock + 8, styleClockFloor);
      target.tombstone = true;
      target.anchor = { replica: replicaIndex, clock: assigned };
      maxAssigned = Math.max(maxAssigned, assigned);
      visible = targetStart + target.length;
      i = targetIndex;
    }
    return maxAssigned;
  }
  function insertVisibleText(doc, start, text, replicaIndex) {
    const replica = doc.replicas[replicaIndex - 1];
    const clock = replica == null ? void 0 : replica.counters[0];
    if (!replica || clock === void 0) {
      throw new Error("Replica entry has no text clock counter");
    }
    if (start > visibleLengthFrom(doc.runs, 0)) {
      throw new Error("Insertion point is past the end of the visible text - CRDT model out of sync");
    }
    let visible = 0;
    let insertIndex = doc.runs.length;
    for (let i = 0; i < doc.runs.length; i += 1) {
      const run = doc.runs[i];
      if (!run) continue;
      if (isSentinel(run)) {
        insertIndex = i;
        break;
      }
      if (run.tombstone || run.length === 0) {
        insertIndex = i + 1;
        continue;
      }
      const runEnd = visible + run.length;
      if (start < runEnd) {
        const offset = start - visible;
        if (offset === 0) {
          insertIndex = i;
        } else {
          splitRunAt(doc.runs, i, offset);
          insertIndex = i + 1;
        }
        break;
      }
      visible = runEnd;
      insertIndex = i + 1;
    }
    const previous = doc.runs[insertIndex - 1];
    if (previous && !previous.tombstone && !isSentinel(previous) && previous.coord.replica === replicaIndex && previous.coord.clock + previous.length === clock) {
      previous.length += text.length;
      replica.counters[0] = clock + text.length;
      return false;
    }
    insertRunAt(doc.runs, insertIndex, {
      coord: { replica: replicaIndex, clock },
      length: text.length,
      // The anchor is the run's style timestamp in the formatting-op clock
      // domain (`counters[1]`), not a position: (replica, 0) = "never
      // restyled", exactly what the iOS client writes for its own plain typed
      // runs (2026-07-29 device captures, vault dev log). Clients bulk-restamp
      // it on style ops. Child edges are wired by `insertRunAt`.
      anchor: { replica: replicaIndex, clock: 0 },
      tombstone: false,
      sequence: []
    });
    replica.counters[0] = clock + text.length;
    return true;
  }
  function visibleLengthFrom(runs, startIndex) {
    let total = 0;
    for (let i = startIndex; i < runs.length; i += 1) {
      const run = runs[i];
      if (run && !run.tombstone) {
        total += run.length;
      }
    }
    return total;
  }
  function ensureReplica(doc, replicaId) {
    const existing = doc.replicas.findIndex((replica) => bytesEqual(replica.id, replicaId));
    if (existing !== -1) {
      return existing + 1;
    }
    const maxTextClock = Math.max(0, ...doc.replicas.map((replica) => {
      var _a;
      return (_a = replica.counters[0]) != null ? _a : 0;
    }));
    const maxOpClock = Math.max(0, ...doc.replicas.map((replica) => {
      var _a;
      return (_a = replica.counters[1]) != null ? _a : 0;
    }));
    doc.replicas.push({ id: replicaId, counters: [maxTextClock, maxOpClock] });
    return doc.replicas.length;
  }
  function styleClockSeed(doc, replicaIndex) {
    var _a, _b, _c, _d, _e;
    const ourId = (_a = doc.replicas[replicaIndex - 1]) == null ? void 0 : _a.id;
    if (!ourId) {
      throw new Error("Replica entry is missing while seeding the style clock");
    }
    let maxClock = -1;
    let maxHolder;
    for (const run of doc.runs) {
      if (run.anchor.replica === 0) {
        continue;
      }
      const holder = (_c = (_b = doc.replicas[run.anchor.replica - 1]) == null ? void 0 : _b.id) != null ? _c : new Uint8Array(16);
      if (run.anchor.clock > maxClock || run.anchor.clock === maxClock && maxHolder && compareBytes(holder, maxHolder) > 0) {
        maxClock = run.anchor.clock;
        maxHolder = holder;
      }
    }
    let seed = 0;
    if (maxHolder !== void 0) {
      seed = maxClock + (compareBytes(maxHolder, ourId) >= 0 ? 1 : 0);
    }
    return Math.max(seed, (_e = (_d = doc.replicas[replicaIndex - 1]) == null ? void 0 : _d.counters[1]) != null ? _e : 0);
  }
  function compareBytes(a, b) {
    var _a, _b;
    const length = Math.min(a.length, b.length);
    for (let i = 0; i < length; i += 1) {
      const delta = ((_a = a[i]) != null ? _a : 0) - ((_b = b[i]) != null ? _b : 0);
      if (delta !== 0) {
        return delta;
      }
    }
    return a.length - b.length;
  }
  function adjustAttributeRuns(doc, start, deleteLength, insertLength) {
    const end = start + deleteLength;
    const out = [];
    let visible = 0;
    for (const run of doc.attributeRuns) {
      const runStart = visible;
      const runEnd = visible + run.length;
      visible = runEnd;
      const overlap = Math.max(0, Math.min(end, runEnd) - Math.max(start, runStart));
      if (run.length - overlap > 0) {
        const piece = clone(AttributeRunSchema, run);
        piece.length = run.length - overlap;
        out.push(piece);
      }
    }
    if (visible < end) {
      throw new Error("Attribute runs are shorter than the deleted range - document model out of sync");
    }
    if (insertLength > 0) {
      let grown = false;
      let runEnd = 0;
      for (let i = 0; i < out.length; i += 1) {
        const run = out[i];
        if (!run) {
          continue;
        }
        runEnd += run.length;
        if (start <= runEnd) {
          if (run.attachmentInfo === void 0) {
            run.length += insertLength;
          } else {
            const piece = clone(AttributeRunSchema, run);
            piece.attachmentInfo = void 0;
            piece.length = insertLength;
            out.splice(start === runEnd ? i + 1 : i, 0, piece);
          }
          grown = true;
          break;
        }
      }
      if (!grown) {
        const lastRun = out[out.length - 1];
        if (lastRun && lastRun.attachmentInfo === void 0) {
          lastRun.length += insertLength;
        } else if (lastRun) {
          const piece = clone(AttributeRunSchema, lastRun);
          piece.attachmentInfo = void 0;
          piece.length = insertLength;
          out.push(piece);
        } else {
          out.push(create(AttributeRunSchema, { length: insertLength }));
        }
      }
    }
    doc.attributeRuns = out;
  }
  function validateDocumentInvariants(doc) {
    var _a;
    const visibleLength = doc.runs.filter((run) => !run.tombstone).reduce((sum, run) => sum + run.length, 0);
    if (visibleLength !== doc.text.length) {
      throw new Error(
        `Visible run lengths (${visibleLength}) do not match note text length (${doc.text.length}) - refusing to touch this note`
      );
    }
    const attributeLength = doc.attributeRuns.reduce((sum, run) => sum + run.length, 0);
    if (attributeLength !== doc.text.length) {
      throw new Error(
        `Attribute run lengths (${attributeLength}) do not match note text length (${doc.text.length}) - refusing to touch this note`
      );
    }
    for (const run of doc.runs) {
      if (isSentinel(run)) {
        continue;
      }
      if (run.coord.replica < 0 || run.coord.replica > doc.replicas.length) {
        throw new Error(`Run references replica ${run.coord.replica} outside the replica table - refusing to touch this note`);
      }
      const replica = run.coord.replica === 0 ? void 0 : doc.replicas[run.coord.replica - 1];
      if (replica) {
        const clock = (_a = replica.counters[0]) != null ? _a : 0;
        if (run.coord.clock + run.length > clock) {
          throw new Error(
            `Run clocks exceed replica ${run.coord.replica}'s counter (${run.coord.clock}+${run.length} > ${clock}) - refusing to touch this note`
          );
        }
      }
    }
    validateChildEdges(doc.runs);
  }
  function validateChildEdges(runs, what = "note") {
    runs.forEach((run, index) => {
      if (isSentinel(run)) {
        return;
      }
      if (run.sequence.length === 0) {
        throw new Error(`Run ${index} has no child edge - refusing to touch this ${what}`);
      }
      for (const child of run.sequence) {
        if (!Number.isInteger(child) || child <= index || child >= runs.length) {
          throw new Error(`Run ${index} has a child edge to ${child}, outside the forward range - refusing to touch this ${what}`);
        }
      }
    });
  }
  function isSentinel(run) {
    return run.coord.clock === SENTINEL_CLOCK;
  }
  function bytesEqual(a, b) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((byte, i) => byte === b[i]);
  }
  var TOMBSTONE_FIELD, SUBCLOCK_FIELD, SENTINEL_CLOCK;
  var init_noteDocument = __esm({
    "vendor/icloud-md/src/notes/noteDocument.ts"() {
      init_esm();
      init_diff3();
      init_topotext_pb();
      init_versioned_document_pb();
      init_versionedDocument();
      TOMBSTONE_FIELD = SubstringSchema.fields.find((f) => f.localName === "tombstone");
      SUBCLOCK_FIELD = VectorTimestamp_Clock_ReplicaClockSchema.fields.find((f) => f.localName === "subclock");
      SENTINEL_CLOCK = 4294967295;
    }
  });

  // src/plugin.js
  var require_plugin = __commonJS({
    "src/plugin.js"() {
      var import_textEncodingPolyfill = __toESM(require_textEncodingPolyfill());
      init_pako();
      init_esm();
      init_topotext_pb();
      init_noteDocument();
      var STORE_KEY = "apple-notes";
      var SECURE_KEYS = [STORE_KEY];
      var secureCache = (function() {
        var values = {};
        var writing = Promise.resolve();
        var failure = null;
        var SAVE_FAILED = "Could not save this plugin's credentials. Try again.";
        function load() {
          return Promise.all(SECURE_KEYS.map(function(key) {
            return Pebble.secureStorage.getItem(key).then(function(value) {
              values[key] = value;
            });
          }));
        }
        var loaded = load();
        function enqueue(write) {
          writing = writing.then(write).catch(function(error) {
            failure = failure || error;
          });
        }
        function flush() {
          return writing.then(function() {
            var error = failure;
            failure = null;
            if (!error) return void 0;
            var rethrow = function() {
              throw error;
            };
            return load().then(rethrow, rethrow);
          });
        }
        function after(fn, onFailure) {
          return function() {
            var args = arguments;
            return flush().then(function() {
              return fn.apply(null, args);
            }, function() {
              return onFailure(args);
            });
          };
        }
        function wrap(name, wrapResponder, fail) {
          var register = Pebble[name];
          Pebble[name] = function(handler) {
            register(function(request, respond) {
              var responder = wrapResponder(respond);
              return loaded.then(function() {
                return handler(request, responder);
              }, function() {
                return fail(respond);
              });
            });
          };
        }
        wrap("registerActionHandler", function(r) {
          var failed = function() {
            return r.error("PLUGIN_UNAVAILABLE", SAVE_FAILED);
          };
          return { ok: after(r.ok, failed), error: after(r.error, function(args) {
            return r.error.apply(null, args);
          }) };
        }, function(r) {
          return r.error("PLUGIN_UNAVAILABLE", SAVE_FAILED);
        });
        wrap("registerSourceHandler", function(r) {
          var failed = function() {
            return r.error("PLUGIN_UNAVAILABLE", SAVE_FAILED);
          };
          return { data: after(r.data, failed), error: after(r.error, function(args) {
            return r.error.apply(null, args);
          }) };
        }, function(r) {
          return r.error("PLUGIN_UNAVAILABLE", SAVE_FAILED);
        });
        wrap("registerConfigHandler", function(r) {
          return after(r, function() {
            return r({ error: SAVE_FAILED });
          });
        }, function(r) {
          return r({ error: SAVE_FAILED });
        });
        return {
          has: function(key) {
            return SECURE_KEYS.indexOf(key) !== -1;
          },
          getItem: function(key) {
            return values[key] === void 0 ? null : values[key];
          },
          setItem: function(key, value) {
            values[key] = String(value);
            enqueue(function() {
              return Pebble.secureStorage.setItem(key, String(value));
            });
          },
          removeItem: function(key) {
            values[key] = null;
            enqueue(function() {
              return Pebble.secureStorage.removeItem(key);
            });
          }
        };
      })();
      var DESTINATION_SOURCES = ["notes/destination", "notes/configured"];
      var SETUP_HOST = "https://setup.icloud.com";
      var ICLOUD_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
      var DEFAULT_FOLDER = "DefaultFolder-CloudKit";
      var CKJS_BUILD_VERSION = "2310ProjectDev27";
      var CKJS_VERSION = "2.6.4";
      var DEFAULT_CLIENT_BUILD_NUMBER = "2624Build27";
      var DEFAULT_CLIENT_MASTERING_NUMBER = "2624Build27";
      var PRIVATE_NOTES_ZONE = { zoneName: "Notes" };
      var RECENT_NOTE_LIMIT = 10;
      function defaultDestination() {
        return { mode: "create", recordName: null, title: null, placement: "bottom" };
      }
      function normalizeDestination(value) {
        if (!value || value.mode !== "append") return defaultDestination();
        var recordName = typeof value.recordName === "string" ? value.recordName.trim() : "";
        var title = typeof value.title === "string" ? value.title.trim() : "";
        if (!recordName) return defaultDestination();
        return {
          mode: "append",
          recordName,
          title: title || "Selected note",
          placement: value.placement === "top" ? "top" : "bottom"
        };
      }
      function emptyState() {
        return {
          session: null,
          dsid: null,
          appleId: null,
          fullName: null,
          ckdatabasewsUrl: null,
          destination: defaultDestination(),
          editorReplicaId: null,
          authGeneration: null
        };
      }
      function state() {
        var saved;
        try {
          saved = JSON.parse(secureCache.getItem(STORE_KEY)) || {};
        } catch (e) {
          saved = {};
        }
        var result = emptyState();
        Object.keys(result).forEach(function(key) {
          if (saved[key] !== void 0) result[key] = saved[key];
        });
        result.destination = normalizeDestination(result.destination);
        return result;
      }
      function saveState(changes) {
        var next = state();
        Object.keys(changes).forEach(function(key) {
          next[key] = changes[key];
        });
        secureCache.setItem(STORE_KEY, JSON.stringify(next));
        return next;
      }
      function clearState() {
        var cleared = emptyState();
        cleared.authGeneration = randomUuid();
        secureCache.setItem(STORE_KEY, JSON.stringify(cleared));
        return cleared;
      }
      function stateWithAuthGeneration() {
        var current = state();
        if (current.session && !current.authGeneration) {
          current = saveState({ authGeneration: randomUuid() });
        }
        return current;
      }
      function generationIsActive(expectedGeneration, requireSession) {
        var current = state();
        return current.authGeneration === expectedGeneration && (!requireSession || !!current.session);
      }
      function staleAuthenticationResult() {
        return {
          ok: false,
          status: 401,
          stale: true,
          error: "Apple Notes was disconnected while the request was running."
        };
      }
      function normalizeSession(value) {
        if (!value || typeof value !== "object") {
          throw new Error("Session JSON must contain an object.");
        }
        var cookie = typeof value.cookie === "string" ? value.cookie.trim() : "";
        var clientId = typeof value.clientId === "string" ? value.clientId.trim() : "";
        var clientBuildNumber = typeof value.clientBuildNumber === "string" ? value.clientBuildNumber.trim() : DEFAULT_CLIENT_BUILD_NUMBER;
        var clientMasteringNumber = typeof value.clientMasteringNumber === "string" ? value.clientMasteringNumber.trim() : DEFAULT_CLIENT_MASTERING_NUMBER;
        if (!cookie) throw new Error("Session JSON is missing cookie.");
        if (!clientId) throw new Error("Session JSON is missing clientId.");
        if (!clientBuildNumber) throw new Error("Session JSON is missing clientBuildNumber.");
        if (!clientMasteringNumber) throw new Error("Session JSON is missing clientMasteringNumber.");
        return {
          cookie,
          clientId,
          clientBuildNumber,
          clientMasteringNumber,
          capturedAt: typeof value.capturedAt === "string" ? value.capturedAt : (/* @__PURE__ */ new Date()).toISOString()
        };
      }
      function parseSessionJson(raw) {
        var parsed;
        try {
          parsed = JSON.parse(String(raw || ""));
        } catch (e) {
          throw new Error("Session JSON is not valid JSON.");
        }
        return normalizeSession(parsed && parsed.session ? parsed.session : parsed);
      }
      function http(method, url, headers, body) {
        return fetch(url, {
          method,
          headers: headers || {},
          body: body === void 0 || body === null ? void 0 : body
        }).then(async function(response) {
          var text = await response.text() || "";
          var json = null;
          try {
            json = JSON.parse(text);
          } catch (e) {
          }
          return {
            ok: response.ok,
            status: response.status,
            json,
            text,
            setCookie: response.headers.get("set-cookie")
          };
        }, function() {
          return { ok: false, status: 0, json: null, text: "", setCookie: null };
        });
      }
      function parseCookieHeader(header) {
        var cookies = [];
        String(header || "").split(";").forEach(function(part) {
          var trimmed = part.trim();
          var equals = trimmed.indexOf("=");
          if (equals > 0) cookies.push([trimmed.substring(0, equals), trimmed.substring(equals + 1)]);
        });
        return cookies;
      }
      function mergeSetCookie(session, setCookie) {
        if (!setCookie) return session;
        var ordered = parseCookieHeader(session.cookie);
        var values = {};
        ordered.forEach(function(pair) {
          values[pair[0]] = pair[1];
        });
        var changed = false;
        var matcher = /(?:^|,\s*)([A-Za-z0-9_.-]+)=([^;,]*)/g;
        var match;
        while ((match = matcher.exec(String(setCookie))) !== null) {
          var name = match[1];
          var value = match[2];
          if (values[name] !== value) changed = true;
          if (!Object.prototype.hasOwnProperty.call(values, name)) ordered.push([name, value]);
          values[name] = value;
        }
        if (!changed) return session;
        return {
          cookie: ordered.map(function(pair) {
            return pair[0] + "=" + values[pair[0]];
          }).join("; "),
          clientId: session.clientId,
          clientBuildNumber: session.clientBuildNumber,
          clientMasteringNumber: session.clientMasteringNumber,
          capturedAt: session.capturedAt
        };
      }
      function queryString(values) {
        return Object.keys(values).map(function(key) {
          return encodeURIComponent(key) + "=" + encodeURIComponent(values[key]);
        }).join("&");
      }
      function randomBytes(length) {
        var bytes = new Uint8Array(length);
        try {
          if (typeof crypto !== "undefined" && crypto.getRandomValues) return crypto.getRandomValues(bytes);
        } catch (e) {
        }
        for (var i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
        return bytes;
      }
      function uuidFromBytes(bytes) {
        var out = [];
        for (var i = 0; i < bytes.length; i++) {
          var hex = bytes[i].toString(16);
          out.push(hex.length === 1 ? "0" + hex : hex);
        }
        return out.slice(0, 4).join("") + "-" + out.slice(4, 6).join("") + "-" + out.slice(6, 8).join("") + "-" + out.slice(8, 10).join("") + "-" + out.slice(10).join("");
      }
      function randomUuid() {
        var bytes = randomBytes(16);
        bytes[6] = bytes[6] & 15 | 64;
        bytes[8] = bytes[8] & 63 | 128;
        return uuidFromBytes(bytes);
      }
      function checkAuthentication(session) {
        var params = queryString({
          clientBuildNumber: session.clientBuildNumber,
          clientMasteringNumber: session.clientMasteringNumber,
          clientId: session.clientId,
          requestId: randomUuid()
        });
        return http("POST", SETUP_HOST + "/setup/ws/1/validate?" + params, {
          Cookie: session.cookie,
          Origin: "https://www.icloud.com",
          Referer: "https://www.icloud.com/",
          "User-Agent": ICLOUD_USER_AGENT,
          Accept: "application/json"
        }, null).then(function(result) {
          var rotated = mergeSetCookie(session, result.setCookie);
          var body = result.json;
          if (!result.ok) {
            return {
              ok: false,
              status: result.status,
              error: body && typeof body.error === "string" ? body.error : result.status ? "Apple returned HTTP " + result.status + "." : "Could not reach iCloud."
            };
          }
          if (!body || !body.dsInfo) {
            return { ok: false, status: result.status, error: "iCloud returned an unexpected authentication response." };
          }
          if (body.hsaChallengeRequired === true || body.dsInfo.hsaChallengeRequired === true) {
            return { ok: false, status: result.status, error: "Apple sign-in still requires 2FA." };
          }
          var dsid = typeof body.dsInfo.dsid === "string" ? body.dsInfo.dsid : "";
          var appleId = typeof body.dsInfo.appleId === "string" ? body.dsInfo.appleId : "";
          var services = body.webservices || {};
          var notes = services.ckdatabasews || {};
          var host = typeof notes.url === "string" ? notes.url.replace(/\/$/, "") : "";
          if (!dsid || !appleId) {
            return { ok: false, status: result.status, error: "iCloud did not return the account identity." };
          }
          if (!host || !/^https:\/\/[^/]+\.icloud\.com(?::\d+)?$/i.test(host)) {
            return { ok: false, status: result.status, error: "Apple Notes is unavailable for this account." };
          }
          return {
            ok: true,
            session: rotated,
            dsid,
            appleId,
            fullName: typeof body.dsInfo.fullName === "string" ? body.dsInfo.fullName : null,
            ckdatabasewsUrl: host
          };
        });
      }
      function verifyAndPersist(session, guard) {
        return checkAuthentication(session).then(function(auth) {
          if (!auth.ok) return auth;
          if (guard && !generationIsActive(guard.expectedGeneration, guard.requireSession === true)) {
            return staleAuthenticationResult();
          }
          var changes = {
            session: auth.session,
            dsid: auth.dsid,
            appleId: auth.appleId,
            fullName: auth.fullName,
            ckdatabasewsUrl: auth.ckdatabasewsUrl
          };
          if (guard && guard.replaceGeneration === true) changes.authGeneration = randomUuid();
          saveState({
            session: changes.session,
            dsid: changes.dsid,
            appleId: changes.appleId,
            fullName: changes.fullName,
            ckdatabasewsUrl: changes.ckdatabasewsUrl,
            authGeneration: changes.authGeneration === void 0 ? state().authGeneration : changes.authGeneration
          });
          return auth;
        });
      }
      function utf8(text) {
        var bytes = [];
        for (var i = 0; i < text.length; i++) {
          var code = text.charCodeAt(i);
          if (code >= 55296 && code <= 56319 && i + 1 < text.length) {
            var low = text.charCodeAt(i + 1);
            if (low >= 56320 && low <= 57343) {
              code = 65536 + (code - 55296 << 10) + (low - 56320);
              i++;
            }
          }
          if (code < 128) bytes.push(code);
          else if (code < 2048) bytes.push(192 | code >> 6, 128 | code & 63);
          else if (code < 65536) bytes.push(224 | code >> 12, 128 | code >> 6 & 63, 128 | code & 63);
          else bytes.push(240 | code >> 18, 128 | code >> 12 & 63, 128 | code >> 6 & 63, 128 | code & 63);
        }
        return new Uint8Array(bytes);
      }
      function concat(parts) {
        var size = parts.reduce(function(sum, part) {
          return sum + part.length;
        }, 0);
        var result = new Uint8Array(size);
        var offset = 0;
        parts.forEach(function(part) {
          result.set(part, offset);
          offset += part.length;
        });
        return result;
      }
      function varint(value) {
        var current = Number(value);
        var bytes = [];
        do {
          var byte = current % 128;
          current = Math.floor(current / 128);
          bytes.push(current ? byte + 128 : byte);
        } while (current);
        return new Uint8Array(bytes);
      }
      function varintField(number, value) {
        return concat([varint(number * 8), varint(value)]);
      }
      function bytesField(number, value) {
        return concat([varint(number * 8 + 2), varint(value.length), value]);
      }
      function charId(replicaId, clock) {
        return concat([varintField(1, replicaId), varintField(2, clock)]);
      }
      function substring(replicaId, clock, length, timestampReplica, timestampClock, child) {
        return concat([
          bytesField(1, charId(replicaId, clock)),
          varintField(2, length),
          bytesField(3, charId(timestampReplica, timestampClock)),
          varintField(5, child)
        ]);
      }
      function sentinelSubstring() {
        var sentinel = 4294967295;
        return concat([
          bytesField(1, charId(0, sentinel)),
          varintField(2, 0),
          bytesField(3, charId(0, sentinel))
        ]);
      }
      function replicaClock(value) {
        return varintField(1, value);
      }
      function vectorClock(replicaId, textLength) {
        var clock = concat([
          bytesField(1, replicaId),
          bytesField(2, replicaClock(textLength)),
          bytesField(2, replicaClock(1))
        ]);
        return bytesField(1, clock);
      }
      function encodeInitialNote(text, replicaId) {
        var length = text.length;
        var topotext = concat([
          bytesField(2, utf8(text)),
          bytesField(3, substring(0, 0, 0, 0, 0, 1)),
          bytesField(3, substring(1, 0, length, 1, 0, 2)),
          bytesField(3, sentinelSubstring()),
          bytesField(4, vectorClock(replicaId, length)),
          bytesField(5, varintField(1, length))
        ]);
        var version = concat([
          varintField(1, 0),
          varintField(2, 0),
          bytesField(3, topotext)
        ]);
        return concat([varintField(1, 0), bytesField(2, version)]);
      }
      function bytesToBase64(bytes) {
        var binary = "";
        var chunk = 32768;
        for (var i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
        }
        return btoa(binary);
      }
      function utf8Base64(text) {
        return bytesToBase64(utf8(text));
      }
      function base64ToBytes(value) {
        var binary = atob(String(value || ""));
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      }
      function base64Utf8(value) {
        var bytes = base64ToBytes(value);
        var escaped = "";
        for (var i = 0; i < bytes.length; i++) {
          var hex = bytes[i].toString(16);
          escaped += "%" + (hex.length === 1 ? "0" + hex : hex);
        }
        try {
          return decodeURIComponent(escaped);
        } catch (e) {
          return "";
        }
      }
      function deriveTitle(text) {
        var lineEnd = text.indexOf("\n");
        var firstLine = lineEnd === -1 ? text : text.substring(0, lineEnd);
        if (firstLine.length <= 76) return firstLine;
        var boundary = firstLine.lastIndexOf(" ", 76);
        return boundary > 0 ? firstLine.substring(0, boundary) : firstLine.substring(0, 76);
      }
      function deriveSnippet(text) {
        var afterTitle = text.substring(deriveTitle(text).length).replace(/^\s+/, "");
        var lineEnd = afterTitle.indexOf("\n");
        var snippet = (lineEnd === -1 ? afterTitle : afterTitle.substring(0, lineEnd)).substring(0, 500);
        return snippet.length ? snippet : "No additional text";
      }
      function buildCreateFields(text, compressedBase64, nowMs) {
        var folder = { recordName: DEFAULT_FOLDER, action: "VALIDATE", zoneID: { zoneName: "Notes" } };
        return {
          CreationDate: { value: nowMs },
          Folders: { value: [folder] },
          Folder: { value: folder },
          ModificationDate: { value: nowMs },
          TitleEncrypted: { value: utf8Base64(deriveTitle(text)) },
          SnippetEncrypted: { value: utf8Base64(deriveSnippet(text)) },
          FirstAttachmentThumbnail: {},
          FirstAttachmentUTIEncrypted: {},
          TextDataAsset: {},
          TextDataEncrypted: { value: compressedBase64 }
        };
      }
      function createNote(current, text) {
        var replicaId = randomBytes(16);
        var recordName = randomUuid();
        var documentBytes = encodeInitialNote(text, replicaId);
        var compressed = deflate(documentBytes);
        var nowMs = Date.now();
        var params = queryString({
          ckjsBuildVersion: CKJS_BUILD_VERSION,
          ckjsVersion: CKJS_VERSION,
          clientId: current.session.clientId,
          clientBuildNumber: current.session.clientBuildNumber,
          clientMasteringNumber: current.session.clientMasteringNumber,
          dsid: current.dsid
        });
        var url = current.ckdatabasewsUrl + "/database/1/com.apple.notes/production/private/records/modify?" + params;
        var body = {
          operations: [{
            operationType: "create",
            record: {
              recordName,
              recordType: "Note",
              fields: buildCreateFields(text, bytesToBase64(compressed), nowMs)
            }
          }],
          zoneID: { zoneName: "Notes" }
        };
        return http("POST", url, {
          Cookie: current.session.cookie,
          "Content-Type": "application/json",
          Origin: "https://www.icloud.com",
          Referer: "https://www.icloud.com/",
          "User-Agent": ICLOUD_USER_AGENT,
          Accept: "application/json"
        }, JSON.stringify(body)).then(function(result) {
          if (!result.ok) {
            return { ok: false, status: result.status, error: result.status ? "Apple Notes returned HTTP " + result.status + "." : "Could not reach Apple Notes." };
          }
          var entry = result.json && result.json.records && result.json.records[0];
          if (!entry) return { ok: false, status: 500, error: "Apple Notes returned no created record." };
          if (entry.serverErrorCode) {
            return {
              ok: false,
              status: 400,
              error: String(entry.reason || entry.serverErrorCode),
              serverErrorCode: String(entry.serverErrorCode)
            };
          }
          return { ok: true, recordName: entry.recordName || recordName };
        });
      }
      function databaseUrl(current, operation) {
        var params = queryString({
          ckjsBuildVersion: CKJS_BUILD_VERSION,
          ckjsVersion: CKJS_VERSION,
          clientId: current.session.clientId,
          clientBuildNumber: current.session.clientBuildNumber,
          clientMasteringNumber: current.session.clientMasteringNumber,
          dsid: current.dsid
        });
        return current.ckdatabasewsUrl + "/database/1/com.apple.notes/production/private/" + operation + "?" + params;
      }
      function postDatabase(current, operation, body) {
        return http("POST", databaseUrl(current, operation), {
          Cookie: current.session.cookie,
          "Content-Type": "application/json",
          Origin: "https://www.icloud.com",
          Referer: "https://www.icloud.com/",
          "User-Agent": ICLOUD_USER_AGENT,
          Accept: "application/json"
        }, JSON.stringify(body)).then(function(result) {
          if (result.ok) return result;
          return {
            ok: false,
            status: result.status,
            error: result.status ? "Apple Notes returned HTTP " + result.status + "." : "Could not reach Apple Notes."
          };
        });
      }
      function noteIsDeleted(record) {
        return record && (record.deleted === true || record.fields && record.fields.Deleted && record.fields.Deleted.value === 1);
      }
      function noteModificationMs(record) {
        var field = record && record.fields && record.fields.ModificationDate;
        if (field && typeof field.value === "number") return field.value;
        if (record && record.modified && typeof record.modified.timestamp === "number") {
          return record.modified.timestamp;
        }
        return 0;
      }
      function noteTitle(record) {
        var field = record && record.fields && record.fields.TitleEncrypted;
        var decoded = field && typeof field.value === "string" ? base64Utf8(field.value).trim() : "";
        return decoded || "Untitled note";
      }
      async function fetchRecentNotes(current) {
        var records = [];
        var syncToken = null;
        var seenTokens = {};
        var moreComing = true;
        while (moreComing) {
          var zoneRequest = {
            zoneID: PRIVATE_NOTES_ZONE,
            desiredKeys: ["TitleEncrypted", "ModificationDate", "Deleted"],
            desiredRecordTypes: ["Note"],
            reverse: true
          };
          if (syncToken) zoneRequest.syncToken = syncToken;
          var result = await postDatabase(current, "changes/zone", { zones: [zoneRequest] });
          if (!result.ok) return result;
          var zones = result.json && result.json.zones;
          var zone = zones && zones[0];
          if (!zone || typeof zone !== "object") {
            return { ok: false, status: 500, error: "Apple Notes returned no Notes zone." };
          }
          if (zone.serverErrorCode) {
            return {
              ok: false,
              status: 400,
              serverErrorCode: String(zone.serverErrorCode),
              error: String(zone.reason || zone.serverErrorCode)
            };
          }
          if (Array.isArray(zone.records)) records = records.concat(zone.records);
          moreComing = zone.moreComing === true;
          if (moreComing) {
            var nextToken = typeof zone.syncToken === "string" ? zone.syncToken : "";
            if (!nextToken || seenTokens[nextToken]) {
              return { ok: false, status: 500, error: "Apple Notes returned invalid list paging data." };
            }
            seenTokens[nextToken] = true;
            syncToken = nextToken;
          }
        }
        var notes = records.filter(function(record) {
          return record && record.recordType === "Note" && typeof record.recordName === "string" && !noteIsDeleted(record);
        }).map(function(record) {
          return {
            recordName: record.recordName,
            title: noteTitle(record),
            modificationDateMs: noteModificationMs(record)
          };
        });
        notes.sort(function(left, right) {
          if (right.modificationDateMs !== left.modificationDateMs) {
            return right.modificationDateMs - left.modificationDateMs;
          }
          return left.recordName < right.recordName ? -1 : left.recordName > right.recordName ? 1 : 0;
        });
        return { ok: true, notes: notes.slice(0, RECENT_NOTE_LIMIT) };
      }
      async function lookupNote(current, recordName) {
        var result = await postDatabase(current, "records/lookup", {
          records: [{ recordName }],
          zoneID: PRIVATE_NOTES_ZONE
        });
        if (!result.ok) return result;
        var entry = result.json && result.json.records && result.json.records[0];
        if (!entry || typeof entry !== "object") {
          return { ok: false, status: 404, error: "The selected Apple Note no longer exists." };
        }
        if (entry.serverErrorCode) {
          return {
            ok: false,
            status: 400,
            serverErrorCode: String(entry.serverErrorCode),
            error: String(entry.reason || entry.serverErrorCode)
          };
        }
        if (entry.recordName !== recordName || entry.recordType !== "Note" || !entry.fields) {
          return { ok: false, status: 500, error: "Apple Notes returned an unexpected selected note." };
        }
        if (noteIsDeleted(entry)) {
          return { ok: false, status: 404, error: "The selected Apple Note was deleted." };
        }
        return { ok: true, record: entry };
      }
      var ECHOED_UPDATE_FIELDS = [
        "MinimumSupportedNotesVersion",
        "Folders",
        "Deleted",
        "Folder",
        "CreationDate",
        "ReplicaIDToNotesVersionDataEncrypted",
        "FoldersModificationDate",
        "AttachmentViewType",
        "PaperStyleType",
        "ReplicaIDToUserIDEncrypted"
      ];
      var NULL_UPDATE_FIELDS = ["FirstAttachmentThumbnail", "FirstAttachmentUTIEncrypted", "TextDataAsset"];
      function buildUpdateFields(record, compressedBase64, text, nowMs) {
        var fields = {
          ModificationDate: { value: nowMs },
          TitleEncrypted: { value: utf8Base64(deriveTitle(text)) }
        };
        ECHOED_UPDATE_FIELDS.forEach(function(name) {
          if (record.fields[name] !== void 0) fields[name] = { value: record.fields[name].value };
        });
        fields.SnippetEncrypted = { value: utf8Base64(deriveSnippet(text)) };
        NULL_UPDATE_FIELDS.forEach(function(name) {
          fields[name] = { value: record.fields[name] && record.fields[name].value != null ? record.fields[name].value : null };
        });
        fields.TextDataEncrypted = { value: compressedBase64 };
        return fields;
      }
      function appendPlan(existing, incoming, placement) {
        var item = incoming.replace(/\s+$/, "");
        if (!existing) return { text: item, listStart: 0, listLength: 0 };
        if (!item) return { text: existing, listStart: 0, listLength: 0 };
        if (placement === "top") {
          var titleEnd = existing.indexOf("\n");
          if (titleEnd === -1) {
            return { text: existing + "\n" + item, listStart: existing.length + 1, listLength: item.length };
          }
          var at = titleEnd + 1;
          var line = item + (at < existing.length ? "\n" : "");
          return { text: existing.substring(0, at) + line + existing.substring(at), listStart: at, listLength: line.length };
        }
        var separator = /\n$/.test(existing) ? "" : "\n";
        var start = existing.length + separator.length;
        return { text: existing + separator + item, listStart: start, listLength: item.length };
      }
      function appendText(existing, incoming, placement) {
        return appendPlan(existing, incoming, placement).text;
      }
      var STYLE_DASHED_LIST = 101;
      var ALIGNMENT_NATURAL = 4;
      function styleRange(document, start, length, style) {
        if (length <= 0) return;
        var end = start + length;
        var position = 0;
        var out = [];
        document.attributeRuns.forEach(function(run) {
          var runStart = position;
          var runEnd = position + run.length;
          position = runEnd;
          var cuts = [runStart, Math.min(Math.max(start, runStart), runEnd), Math.min(Math.max(end, runStart), runEnd), runEnd];
          for (var i = 0; i < 3; i++) {
            var pieceLength = cuts[i + 1] - cuts[i];
            if (pieceLength <= 0) continue;
            if (i === 1 && run.attachmentInfo !== void 0) throw new Error("Could not style text next to an attachment safely.");
            var piece = i !== 1 ? clone(AttributeRunSchema, run) : style === null ? create(AttributeRunSchema, { length: pieceLength }) : create(AttributeRunSchema, { length: pieceLength, paragraphStyle: { style, alignment: ALIGNMENT_NATURAL } });
            piece.length = pieceLength;
            out.push(piece);
          }
        });
        document.attributeRuns = out;
      }
      function editorReplicaBytes(current) {
        if (typeof current.editorReplicaId === "string") {
          try {
            var saved = base64ToBytes(current.editorReplicaId);
            if (saved.length === 16) return saved;
          } catch (error) {
          }
        }
        var created = randomBytes(16);
        saveState({ editorReplicaId: bytesToBase64(created) });
        return created;
      }
      function promoteReplicaToFront(document, replicaId) {
        var oldIndex = document.replicas.findIndex(function(replica) {
          return bytesEqual(replica.id, replicaId);
        });
        var ours;
        if (oldIndex === -1) {
          ours = {
            id: replicaId,
            counters: [
              Math.max.apply(null, [0].concat(document.replicas.map(function(replica) {
                return replica.counters[0] || 0;
              }))),
              Math.max.apply(null, [0].concat(document.replicas.map(function(replica) {
                return replica.counters[1] || 0;
              })))
            ]
          };
        } else {
          ours = document.replicas[oldIndex];
        }
        var oldSlot = oldIndex + 1;
        function remap(slot) {
          if (slot === 0) return 0;
          if (oldIndex !== -1 && slot === oldSlot) return 1;
          if (oldIndex === -1 || slot < oldSlot) return slot + 1;
          return slot;
        }
        document.runs.forEach(function(run) {
          run.coord.replica = remap(run.coord.replica);
          run.anchor.replica = remap(run.anchor.replica);
        });
        document.replicas = [ours].concat(document.replicas.filter(function(replica) {
          return replica !== ours;
        }));
      }
      function prepareAppend(record, incoming, placement, replicaId) {
        if (incoming.indexOf("\uFFFC") !== -1) {
          return { ok: false, status: 400, error: "The appended text contains an embedded-object marker." };
        }
        if (!record.recordChangeTag || typeof record.recordChangeTag !== "string") {
          return { ok: false, status: 500, error: "The selected Apple Note has no concurrency token." };
        }
        var bodyField = record.fields.TextDataEncrypted;
        if (!bodyField || typeof bodyField.value !== "string") {
          return { ok: false, status: 400, error: "The selected Apple Note has no editable text body." };
        }
        if (record.fields.TextDataAsset && record.fields.TextDataAsset.value != null) {
          return { ok: false, status: 400, error: "The selected Apple Note is too large to edit safely." };
        }
        try {
          var raw = inflate(base64ToBytes(bodyField.value));
          if (!noteDocumentRoundTrips(raw)) {
            return { ok: false, status: 400, error: "The selected Apple Note uses an unsupported document format." };
          }
          var document = parseNoteDocument(raw);
          var plan = appendPlan(document.text, incoming, placement);
          promoteReplicaToFront(document, replicaId);
          applyTextEdit(document, plan.text, { replicaId });
          if (plan.listLength > 0) styleRange(document, plan.listStart, plan.listLength, STYLE_DASHED_LIST);
          validateDocumentInvariants(document);
          var rebuilt = encodeNoteDocument(document);
          if (!noteDocumentRoundTrips(rebuilt) || parseNoteDocument(rebuilt).text !== plan.text) {
            return { ok: false, status: 500, error: "Apple Note append verification failed before upload." };
          }
          var compressed = deflate(rebuilt);
          if (parseNoteDocument(inflate(compressed)).text !== plan.text) {
            return { ok: false, status: 500, error: "Compressed Apple Note verification failed before upload." };
          }
          return {
            ok: true,
            text: plan.text,
            compressedBase64: bytesToBase64(compressed)
          };
        } catch (error) {
          return {
            ok: false,
            status: 400,
            error: "The selected Apple Note could not be edited safely: " + (error && error.message ? error.message : String(error))
          };
        }
      }
      async function appendToNote(current, destination, incoming, expectedGeneration) {
        var lookedUp = await lookupNote(current, destination.recordName);
        if (!lookedUp.ok) return lookedUp;
        if (!generationIsActive(expectedGeneration, true)) return staleAuthenticationResult();
        var prepared = prepareAppend(
          lookedUp.record,
          incoming,
          destination.placement,
          editorReplicaBytes(current)
        );
        if (!prepared.ok) return prepared;
        var record = {
          recordName: lookedUp.record.recordName,
          recordType: "Note",
          recordChangeTag: lookedUp.record.recordChangeTag,
          fields: buildUpdateFields(lookedUp.record, prepared.compressedBase64, prepared.text, Date.now())
        };
        if (lookedUp.record.parent && typeof lookedUp.record.parent.recordName === "string") {
          record.parent = { recordName: lookedUp.record.parent.recordName };
        }
        var result = await postDatabase(current, "records/modify", {
          operations: [{ operationType: "update", record }],
          zoneID: PRIVATE_NOTES_ZONE
        });
        if (!result.ok) return result;
        if (!generationIsActive(expectedGeneration, true)) return staleAuthenticationResult();
        var entry = result.json && result.json.records && result.json.records[0];
        if (!entry || typeof entry !== "object") {
          return { ok: false, status: 500, error: "Apple Notes returned no updated record." };
        }
        if (entry.serverErrorCode) {
          return {
            ok: false,
            status: 400,
            serverErrorCode: String(entry.serverErrorCode),
            error: String(entry.reason || entry.serverErrorCode)
          };
        }
        return {
          ok: true,
          recordName: entry.recordName || destination.recordName,
          title: noteTitle(lookedUp.record)
        };
      }
      function pluginError(result) {
        if (result.status === 401 || result.status === 403 || result.status === 421 || /AUTH|NOT_AUTHENTICATED|SESSION/i.test(String(result.serverErrorCode || ""))) {
          return { code: "AUTH_REQUIRED", message: result.error || "Apple authorization expired." };
        }
        if (result.status === 429 || /THROTTL|RATE_LIMIT/i.test(String(result.serverErrorCode || ""))) {
          return { code: "RATE_LIMITED", message: result.error || "Apple Notes rate limit reached." };
        }
        if (/SERVER_RECORD_CHANGED|CONFLICT/i.test(String(result.serverErrorCode || ""))) {
          return { code: "PLUGIN_UNAVAILABLE", message: "The selected Apple Note changed; try again." };
        }
        if (result.status === 404 || /NOT_FOUND|UNKNOWN_ITEM/i.test(String(result.serverErrorCode || ""))) {
          return { code: "PLUGIN_UNAVAILABLE", message: result.error || "The selected Apple Note no longer exists." };
        }
        return { code: "PLUGIN_UNAVAILABLE", message: result.error || "Apple Notes is unavailable." };
      }
      function shortText(text) {
        return { shortText: { text: String(text) } };
      }
      function textReading(text) {
        return { shortText: { text: String(text) }, longText: { text: String(text) } };
      }
      function booleanReading(value) {
        return {
          boolean: { value: !!value },
          shortText: { text: value ? "Connected" : "Not connected" }
        };
      }
      function appleNotesUrl(recordName) {
        return "applenotes://showNote?identifier=" + encodeURIComponent(recordName);
      }
      Pebble.registerSourceHandler(function(request, respond) {
        var isConfiguredSource = request.category === "notes" && request.item === "configured";
        if (!isConfiguredSource && (request.category !== "notes" || request.item !== "destination")) {
          respond.error("PLUGIN_UNAVAILABLE", "Unknown source " + request.category + "/" + request.item + ".");
          return;
        }
        var current = state();
        var configured = !!current.session && !!current.dsid && !!current.ckdatabasewsUrl;
        if (isConfiguredSource) {
          respond.data({
            validUntilMs: Date.now() + 60 * 1e3,
            instances: [{
              instanceId: "apple-notes",
              properties: { name: shortText("Apple Notes"), configured: booleanReading(configured) }
            }]
          });
          return;
        }
        respond.data({
          validUntilMs: Date.now() + 60 * 1e3,
          instances: [{
            instanceId: "apple-notes",
            properties: {
              name: shortText("Apple Notes"),
              configured: booleanReading(configured),
              account: textReading(current.appleId || "Sign in to Apple in Apple Notes settings"),
              url: { longText: { text: "https://www.icloud.com/notes/" } }
            }
          }]
        });
      });
      Pebble.registerActionHandler(async function(request, respond) {
        if (request.action !== "create_note") {
          respond.error("PLUGIN_UNAVAILABLE", "Unknown action " + request.action + ".");
          return;
        }
        var args = request.args || {};
        if (args.instanceId !== void 0 && args.instanceId !== "apple-notes") {
          respond.error("INVALID_ARGS", "Unknown notes destination " + args.instanceId + ".");
          return;
        }
        var text = typeof args.text === "string" ? args.text : "";
        if (!text.trim()) {
          respond.error("INVALID_ARGS", "The note text cannot be empty.");
          return;
        }
        var current = stateWithAuthGeneration();
        if (!current.session) {
          respond.error("AUTH_REQUIRED", "Sign in to Apple in Apple Notes settings first.");
          return;
        }
        var expectedGeneration = current.authGeneration;
        var auth = await verifyAndPersist(current.session, {
          expectedGeneration,
          requireSession: true
        });
        if (!auth.ok) {
          var authError = pluginError(auth);
          respond.error(authError.code, authError.message);
          return;
        }
        current = state();
        if (!generationIsActive(expectedGeneration, true)) {
          var disconnected = pluginError(staleAuthenticationResult());
          respond.error(disconnected.code, disconnected.message);
          return;
        }
        var oneLine = text.trim().replace(/\s+/g, " ");
        var excerpt = oneLine.length > 42 ? oneLine.substring(0, 39) + "..." : oneLine;
        var destination = normalizeDestination(current.destination);
        if (destination.mode === "append") {
          var appended = await appendToNote(current, destination, text, expectedGeneration);
          if (!appended.ok) {
            var appendError = pluginError(appended);
            respond.error(appendError.code, appendError.message);
            return;
          }
          if (appended.title !== destination.title) {
            destination.title = appended.title;
            saveState({ destination });
          }
          Pebble.refreshSources(DESTINATION_SOURCES);
          respond.ok({
            text: "Added to the " + destination.placement + " of \u201C" + appended.title + "\u201D in Apple Notes",
            url: appleNotesUrl(appended.recordName),
            refreshed: DESTINATION_SOURCES
          });
          return;
        }
        var created = await createNote(current, text);
        if (!created.ok) {
          var createError = pluginError(created);
          respond.error(createError.code, createError.message);
          return;
        }
        if (!generationIsActive(expectedGeneration, true)) {
          var createDisconnected = pluginError(staleAuthenticationResult());
          respond.error(createDisconnected.code, createDisconnected.message);
          return;
        }
        Pebble.refreshSources(DESTINATION_SOURCES);
        respond.ok({
          text: "Saved to Apple Notes: \u201C" + excerpt + "\u201D",
          url: appleNotesUrl(created.recordName),
          refreshed: DESTINATION_SOURCES
        });
      });
      Pebble.registerConfigHandler(async function(message, respond) {
        var current = state();
        switch (message && message.type) {
          case "status":
            respond({
              configured: !!current.session,
              ready: !!current.session && !!current.dsid && !!current.ckdatabasewsUrl,
              appleId: current.appleId,
              fullName: current.fullName,
              capturedAt: current.session && current.session.capturedAt,
              destination: normalizeDestination(current.destination)
            });
            return;
          case "setSession": {
            var previousAppleId = current.appleId;
            var setSessionGeneration = current.authGeneration;
            var session;
            try {
              session = parseSessionJson(message.sessionJson);
            } catch (e) {
              respond({ error: e.message || String(e) });
              return;
            }
            var auth = await verifyAndPersist(session, {
              expectedGeneration: setSessionGeneration,
              requireSession: false,
              replaceGeneration: true
            });
            if (!auth.ok) {
              respond({ error: auth.error, authRequired: true });
              return;
            }
            if (previousAppleId && previousAppleId !== auth.appleId) {
              saveState({ destination: defaultDestination() });
            }
            Pebble.refreshSources(DESTINATION_SOURCES);
            respond({
              configured: true,
              ready: true,
              appleId: auth.appleId,
              fullName: auth.fullName,
              destination: state().destination
            });
            return;
          }
          case "verify": {
            current = stateWithAuthGeneration();
            if (!current.session) {
              respond({ error: "Sign in to Apple first.", authRequired: true });
              return;
            }
            var checked = await verifyAndPersist(current.session, {
              expectedGeneration: current.authGeneration,
              requireSession: true
            });
            if (!checked.ok) {
              respond({ error: checked.error, authRequired: true });
              return;
            }
            Pebble.refreshSources(DESTINATION_SOURCES);
            respond({ ready: true, appleId: checked.appleId, fullName: checked.fullName });
            return;
          }
          case "listNotes": {
            current = stateWithAuthGeneration();
            if (!current.session) {
              respond({ error: "Sign in to iCloud first.", authRequired: true });
              return;
            }
            var listGeneration = current.authGeneration;
            var listAuth = await verifyAndPersist(current.session, {
              expectedGeneration: listGeneration,
              requireSession: true
            });
            if (!listAuth.ok) {
              respond({ error: listAuth.error, authRequired: true });
              return;
            }
            current = state();
            var listed = await fetchRecentNotes(current);
            if (!listed.ok) {
              var listError = pluginError(listed);
              respond({ error: listError.message });
              return;
            }
            if (!generationIsActive(listGeneration, true)) {
              respond({ error: staleAuthenticationResult().error, authRequired: true });
              return;
            }
            respond({ notes: listed.notes, destination: normalizeDestination(current.destination) });
            return;
          }
          case "setDestination": {
            var destination;
            if (message.mode === "create") {
              destination = defaultDestination();
            } else if (message.mode === "append") {
              destination = normalizeDestination({
                mode: "append",
                recordName: message.recordName,
                title: message.title,
                placement: message.placement
              });
              if (destination.mode !== "append") {
                respond({ error: "Choose an Apple Note to append to." });
                return;
              }
            } else {
              respond({ error: "Unknown Apple Notes destination mode." });
              return;
            }
            saveState({ destination });
            Pebble.refreshSources(DESTINATION_SOURCES);
            respond({ saved: true, destination });
            return;
          }
          case "disconnect":
          case "unlink":
            clearState();
            Pebble.refreshSources(DESTINATION_SOURCES);
            respond({ configured: false, ready: false });
            return;
          default:
            respond({ error: "Unknown Apple Notes configuration command." });
        }
      });
      globalThis.__appleNotesPbwTest = {
        encodeInitialNote,
        buildCreateFields,
        buildUpdateFields,
        appendText,
        prepareAppend,
        parseNoteDocument,
        inflate,
        deflate,
        base64ToBytes,
        bytesToBase64,
        encodeNoteDocument,
        utf8
      };
    }
  });
  require_plugin();
})();
