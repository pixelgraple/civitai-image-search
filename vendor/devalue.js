var ISSDevalue = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // devalue-entry.js
  var devalue_entry_exports = {};
  __export(devalue_entry_exports, {
    parse: () => parse
  });

  // node_modules/devalue/src/constants.js
  var UNDEFINED = -1;
  var HOLE = -2;
  var NAN = -3;
  var POSITIVE_INFINITY = -4;
  var NEGATIVE_INFINITY = -5;
  var NEGATIVE_ZERO = -6;
  var SPARSE = -7;
  var MAX_ARRAY_LEN = 2 ** 32 - 1;
  var MAX_ARRAY_INDEX = MAX_ARRAY_LEN - 1;

  // node_modules/devalue/src/utils.js
  var object_proto_names = /* @__PURE__ */ Object.getOwnPropertyNames(Object.prototype).sort().join("\0");
  function is_plain_object(thing) {
    const proto = Object.getPrototypeOf(thing);
    return proto === Object.prototype || proto === null || Object.getPrototypeOf(proto) === null || Object.getOwnPropertyNames(proto).sort().join("\0") === object_proto_names;
  }
  function get_type(thing) {
    return Object.prototype.toString.call(thing).slice(8, -1);
  }
  function enumerable_symbols(object) {
    return Object.getOwnPropertySymbols(object).filter(
      (symbol) => Object.getOwnPropertyDescriptor(object, symbol).enumerable
    );
  }
  function is_valid_array_index(n) {
    if (!Number.isInteger(n)) return false;
    if (n < 0) return false;
    if (n > MAX_ARRAY_INDEX) return false;
    return true;
  }
  function is_valid_array_len(n) {
    if (!Number.isInteger(n)) return false;
    if (n < 0) return false;
    if (n > MAX_ARRAY_LEN) return false;
    return true;
  }
  function is_valid_array_index_string(s) {
    if (s.length === 0) return false;
    if (s.length > 1 && s.charCodeAt(0) === 48) return false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 48 || c > 57) return false;
    }
    return is_valid_array_index(+s);
  }
  function array_index_cut(keys) {
    for (var i = keys.length - 1; i >= 0; i--) {
      if (is_valid_array_index_string(keys[i])) {
        break;
      }
    }
    return i + 1;
  }
  function valid_array_indices(array) {
    const keys = Object.keys(array);
    keys.length = array_index_cut(keys);
    return keys;
  }

  // node_modules/devalue/src/base64.js
  function decode_native(base64) {
    return Uint8Array.fromBase64(base64).buffer;
  }
  function decode_buffer(base64) {
    return Uint8Array.from(Buffer.from(base64, "base64")).buffer;
  }
  function decode_legacy(base64) {
    const binary_string = atob(base64);
    const len = binary_string.length;
    const array = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      array[i] = binary_string.charCodeAt(i);
    }
    return array.buffer;
  }
  var native = typeof Uint8Array.fromBase64 === "function";
  var buffer = typeof process === "object" && process.versions?.node !== void 0;
  var decode64 = native ? decode_native : buffer ? decode_buffer : decode_legacy;

  // node_modules/devalue/src/operations.js
  function merge_operations(defaults, overrides) {
    if (!overrides) return defaults;
    const merged = (
      /** @type {T} */
      {}
    );
    for (
      const key of
      /** @type {(keyof T)[]} */
      Object.keys(defaults)
    ) {
      merged[key] = overrides[key] ?? defaults[key];
    }
    return merged;
  }
  var NOT_PLAIN = Object.freeze({ kind: "not-plain" });
  var SYMBOL_KEYS = Object.freeze({ kind: "symbol-keys" });
  var stringify_operations = {
    identify: (value) => value,
    typeOf: (value) => value === null ? "null" : typeof value,
    toPrimitive: (value) => value,
    tagOf: (value) => get_type(value),
    isThenable: (value) => typeof value.then === "function",
    toPromise: (thenable) => Promise.resolve(thenable),
    unbox: (boxed) => boxed.valueOf(),
    toISOString: (date) => isNaN(date.getDate()) ? "" : date.toISOString(),
    toStringValue: (value) => value.toString(),
    regExpInfo: (regexp) => ({ source: regexp.source, flags: regexp.flags }),
    valuesOf: (set) => set,
    entriesOf: (map) => map,
    viewInfo: (view) => ({
      buffer: view.buffer,
      byteOffset: view.byteOffset,
      byteLength: view.byteLength,
      length: view.length,
      bufferByteLength: view.buffer.byteLength
    }),
    toArrayBuffer: (buffer2) => buffer2,
    lengthOf: (array) => array.length,
    hasOwn: (value, key) => Object.hasOwn(value, key),
    indicesOf: (array) => valid_array_indices(array),
    shapeOf: (value) => {
      if (!is_plain_object(value)) return NOT_PLAIN;
      if (enumerable_symbols(value).length > 0) return SYMBOL_KEYS;
      return {
        kind: Object.getPrototypeOf(value) === null ? "null-proto" : "plain",
        keys: Object.keys(value)
      };
    },
    get: (value, key) => value[key]
  };
  var default_stringify_operations = Object.freeze(stringify_operations);
  var parse_operations = {
    fromPrimitive: (primitive) => primitive,
    fromISOString: (iso) => new Date(iso),
    fromStringValue: (tag, text) => {
      if (tag === "URL") return new URL(text);
      if (tag === "URLSearchParams") return new URLSearchParams(text);
      return Temporal[tag.slice(9)].from(text);
    },
    fromArrayBuffer: (buffer2) => buffer2,
    fromRegExpInfo: (source, flags) => new RegExp(source, flags),
    fromViewInfo: (tag, buffer2, byteOffset, length) => {
      const Constructor = (
        /** @type {any} */
        globalThis[tag]
      );
      return byteOffset !== void 0 ? new Constructor(buffer2, byteOffset, length) : new Constructor(buffer2);
    },
    box: (value) => Object(value),
    createArray: (length) => new Array(length),
    createSparseArray: (length) => {
      const array = [];
      array[MAX_ARRAY_INDEX] = void 0;
      delete array[MAX_ARRAY_INDEX];
      array.length = length;
      return array;
    },
    createObject: () => ({}),
    createNullPrototypeObject: () => /* @__PURE__ */ Object.create(null),
    createSet: () => /* @__PURE__ */ new Set(),
    createMap: () => /* @__PURE__ */ new Map(),
    set: (target, key, value) => {
      target[key] = value;
    },
    addValue: (set, value) => {
      set.add(value);
    },
    addEntry: (map, key, value) => {
      map.set(key, value);
    }
  };
  var default_parse_operations = Object.freeze(parse_operations);

  // node_modules/devalue/src/parse.js
  function parse(serialized, revivers, options) {
    return unflatten(JSON.parse(serialized), revivers, options);
  }
  function unflatten(parsed, revivers, options) {
    const ops = merge_operations(default_parse_operations, options?.operations);
    if (typeof parsed === "number") return hydrate(parsed, true);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("Invalid input");
    }
    const values = (
      /** @type {any[]} */
      parsed
    );
    const hydrated = Array(values.length);
    let hydrating = null;
    function hydrate(index, standalone = false) {
      if (index === UNDEFINED) return ops.fromPrimitive(void 0);
      if (index === NAN) return ops.fromPrimitive(NaN);
      if (index === POSITIVE_INFINITY) return ops.fromPrimitive(Infinity);
      if (index === NEGATIVE_INFINITY) return ops.fromPrimitive(-Infinity);
      if (index === NEGATIVE_ZERO) return ops.fromPrimitive(-0);
      if (standalone || typeof index !== "number") {
        throw new Error(`Invalid input`);
      }
      if (index in hydrated) return hydrated[index];
      if (index >= values.length) {
        throw new Error(`Invalid input`);
      }
      const value = values[index];
      if (!value || typeof value !== "object") {
        hydrated[index] = ops.fromPrimitive(value);
      } else if (Array.isArray(value)) {
        if (typeof value[0] === "string") {
          const type = value[0];
          const reviver = revivers && Object.hasOwn(revivers, type) ? revivers[type] : void 0;
          if (reviver) {
            let i = value[1];
            if (typeof i !== "number") {
              i = values.push(value[1]) - 1;
            }
            if (Object.hasOwn(hydrated, i)) {
              return hydrated[index] = reviver(hydrated[i]);
            }
            hydrating ??= /* @__PURE__ */ new Set();
            if (hydrating.has(i)) {
              throw new Error("Invalid circular reference");
            }
            hydrating.add(i);
            hydrated[index] = reviver(hydrate(i));
            hydrating.delete(i);
            return hydrated[index];
          }
          switch (type) {
            case "Date":
              hydrated[index] = ops.fromISOString(value[1]);
              break;
            case "Set":
              const set = ops.createSet();
              hydrated[index] = set;
              for (let i = 1; i < value.length; i += 1) {
                ops.addValue(set, hydrate(value[i]));
              }
              break;
            case "Map":
              const map = ops.createMap();
              hydrated[index] = map;
              for (let i = 1; i < value.length; i += 2) {
                ops.addEntry(map, hydrate(value[i]), hydrate(value[i + 1]));
              }
              break;
            case "RegExp":
              hydrated[index] = ops.fromRegExpInfo(value[1], value[2]);
              break;
            case "Object": {
              const wrapped_index = value[1];
              if (typeof values[wrapped_index] === "object" && values[wrapped_index][0] !== "BigInt") {
                throw new Error("Invalid input");
              }
              hydrated[index] = ops.box(hydrate(wrapped_index));
              break;
            }
            case "BigInt":
              hydrated[index] = ops.fromPrimitive(BigInt(value[1]));
              break;
            case "null":
              const obj = ops.createNullPrototypeObject();
              hydrated[index] = obj;
              for (let i = 1; i < value.length; i += 2) {
                if (value[i] === "__proto__") {
                  throw new Error("Cannot parse an object with a `__proto__` property");
                }
                ops.set(obj, value[i], hydrate(value[i + 1]));
              }
              break;
            case "Int8Array":
            case "Uint8Array":
            case "Uint8ClampedArray":
            case "Int16Array":
            case "Uint16Array":
            case "Float16Array":
            case "Int32Array":
            case "Uint32Array":
            case "Float32Array":
            case "Float64Array":
            case "BigInt64Array":
            case "BigUint64Array":
            case "DataView": {
              if (values[value[1]][0] !== "ArrayBuffer") {
                throw new Error("Invalid data");
              }
              const buffer2 = hydrate(value[1]);
              hydrated[index] = ops.fromViewInfo(type, buffer2, value[2], value[3]);
              break;
            }
            case "ArrayBuffer": {
              const base64 = value[1];
              if (typeof base64 !== "string") {
                throw new Error("Invalid ArrayBuffer encoding");
              }
              hydrated[index] = ops.fromArrayBuffer(decode64(base64));
              break;
            }
            case "URL":
            case "URLSearchParams":
            case "Temporal.Duration":
            case "Temporal.Instant":
            case "Temporal.PlainDate":
            case "Temporal.PlainTime":
            case "Temporal.PlainDateTime":
            case "Temporal.PlainMonthDay":
            case "Temporal.PlainYearMonth":
            case "Temporal.ZonedDateTime": {
              hydrated[index] = ops.fromStringValue(type, value[1]);
              break;
            }
            default:
              throw new Error(`Unknown type ${type}`);
          }
        } else if (value[0] === SPARSE) {
          const len = value[1];
          if (!is_valid_array_len(len)) {
            throw new Error("Invalid input");
          }
          const array = ops.createSparseArray(len);
          hydrated[index] = array;
          for (let i = 2; i < value.length; i += 2) {
            const idx = value[i];
            if (!is_valid_array_index(idx) || idx >= len) {
              throw new Error("Invalid input");
            }
            ops.set(array, idx, hydrate(value[i + 1]));
          }
        } else {
          const array = ops.createArray(value.length);
          hydrated[index] = array;
          for (let i = 0; i < value.length; i += 1) {
            const n = value[i];
            if (n === HOLE) continue;
            ops.set(array, i, hydrate(n));
          }
        }
      } else {
        const object = ops.createObject();
        hydrated[index] = object;
        for (const key of Object.keys(value)) {
          if (key === "__proto__") {
            throw new Error("Cannot parse an object with a `__proto__` property");
          }
          ops.set(object, key, hydrate(value[key]));
        }
      }
      return hydrated[index];
    }
    return hydrate(0);
  }
  return __toCommonJS(devalue_entry_exports);
})();
