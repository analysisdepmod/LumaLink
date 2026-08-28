export async function instantiate(module, imports = {}) {
  const adaptedImports = {
    env: Object.setPrototypeOf({
      abort(message, fileName, lineNumber, columnNumber) {
        // ~lib/builtins/abort(~lib/string/String | null?, ~lib/string/String | null?, u32?, u32?) => void
        message = __liftString(message >>> 0);
        fileName = __liftString(fileName >>> 0);
        lineNumber = lineNumber >>> 0;
        columnNumber = columnNumber >>> 0;
        (() => {
          // @external.js
          throw Error(`${message} in ${fileName}:${lineNumber}:${columnNumber}`);
        })();
      },
    }, Object.assign(Object.create(globalThis), imports.env || {})),
  };
  const { exports } = await WebAssembly.instantiate(module, adaptedImports);
  const memory = exports.memory || imports.env.memory;
  const adaptedExports = Object.setPrototypeOf({
    pCheckStart() {
      // assembly/ldpcbp/pCheckStart() => usize
      return exports.pCheckStart() >>> 0;
    },
    pEdgeVar() {
      // assembly/ldpcbp/pEdgeVar() => usize
      return exports.pEdgeVar() >>> 0;
    },
    pVarStart() {
      // assembly/ldpcbp/pVarStart() => usize
      return exports.pVarStart() >>> 0;
    },
    pVarEdge() {
      // assembly/ldpcbp/pVarEdge() => usize
      return exports.pVarEdge() >>> 0;
    },
    pLlr() {
      // assembly/ldpcbp/pLlr() => usize
      return exports.pLlr() >>> 0;
    },
    pHard() {
      // assembly/ldpcbp/pHard() => usize
      return exports.pHard() >>> 0;
    },
  }, exports);
  function __liftString(pointer) {
    if (!pointer) return null;
    const
      end = pointer + new Uint32Array(memory.buffer)[pointer - 4 >>> 2] >>> 1,
      memoryU16 = new Uint16Array(memory.buffer);
    let
      start = pointer >>> 1,
      string = "";
    while (end - start > 1024) string += String.fromCharCode(...memoryU16.subarray(start, start += 1024));
    return string + String.fromCharCode(...memoryU16.subarray(start, end));
  }
  return adaptedExports;
}
