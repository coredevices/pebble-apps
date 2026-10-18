#include <stddef.h>
#include <sys/types.h>
#include <emscripten.h>
EM_JS(int, wasm_random, (void *buffer, size_t size), {
  var data = Module['randomBytes'](size);
  if (!(data instanceof Uint8Array) || data.length !== size) return -1;
  HEAPU8.set(data, buffer);
  return size;
});
ssize_t GetRandom(void *bytes, size_t size, int flags) {
  (void)flags;
  return wasm_random(bytes, size);
}
